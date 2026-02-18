/**
 * SecureClaw Web Executor — headless browser in a sandboxed container.
 *
 * The highest-risk executor component. Runs Playwright with Chromium
 * inside a Docker container with strict network controls.
 *
 * Security layers:
 * 1. DNS proxy: Only resolves domains in the capability token's allowedDomains list
 * 2. SSRF protection: Blocks all private IP ranges after DNS resolution
 * 3. iptables: DROP all outbound except TCP 443 (HTTPS)
 * 4. No filesystem mounts from the host
 * 5. Capability token verification
 *
 * Task format:
 * {
 *   action: 'navigate' | 'click' | 'type' | 'screenshot' | 'extract',
 *   params: {
 *     url?: string,
 *     selector?: string,
 *     text?: string,
 *     screenshot?: boolean
 *   }
 * }
 *
 * Returns: accessibility tree snapshot + optional base64 screenshot
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { verifyCapabilityToken, type Capability } from '@secureclaw/shared';
import { DNSProxy } from './dns-proxy.js';
import {
  captureAccessibilityTree,
  extractMainContent,
} from './accessibility-tree.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebTask {
  action: 'navigate' | 'click' | 'type' | 'screenshot' | 'extract';
  params: {
    url?: string;
    selector?: string;
    text?: string;
    screenshot?: boolean;
  };
}

interface WebResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Environment & Validation
// ---------------------------------------------------------------------------

const CAPABILITY_TOKEN = process.env['CAPABILITY_TOKEN'];
const TASK_BASE64 = process.env['TASK'];
const CAPABILITY_SECRET = process.env['CAPABILITY_SECRET'];

if (!CAPABILITY_TOKEN || !TASK_BASE64 || !CAPABILITY_SECRET) {
  const result: WebResult = {
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: 'Missing required environment variables: CAPABILITY_TOKEN, TASK, CAPABILITY_SECRET',
    durationMs: 0,
    error: 'Missing environment variables',
  };
  console.log(JSON.stringify(result));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main Execution
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();

  let capability: Capability;
  let task: WebTask;

  // Step 1: Verify capability token
  try {
    capability = verifyCapabilityToken(CAPABILITY_TOKEN!, CAPABILITY_SECRET!);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    outputResult({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: `Capability token verification failed: ${error.message}`,
      durationMs: Date.now() - startTime,
      error: 'Invalid capability token',
    });
    return;
  }

  // Step 2: Validate executor type
  if (capability.executorType !== 'web') {
    outputResult({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: `Wrong executor type: expected "web", got "${capability.executorType}"`,
      durationMs: Date.now() - startTime,
      error: 'Wrong executor type',
    });
    return;
  }

  // Step 3: Decode task
  try {
    const taskJson = Buffer.from(TASK_BASE64!, 'base64').toString('utf-8');
    task = JSON.parse(taskJson) as WebTask;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    outputResult({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: `Failed to decode task: ${error.message}`,
      durationMs: Date.now() - startTime,
      error: 'Invalid task payload',
    });
    return;
  }

  // Step 4: Initialize DNS proxy with allowed domains
  const allowedDomains =
    capability.network !== 'none' ? capability.network.allowedDomains : [];

  if (allowedDomains.length === 0) {
    outputResult({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'No allowed domains in capability token. Web executor requires network access.',
      durationMs: Date.now() - startTime,
      error: 'No allowed domains',
    });
    return;
  }

  const dnsProxy = new DNSProxy(allowedDomains);

  // Step 5: Validate URL if navigating
  if (task.params.url) {
    try {
      await dnsProxy.validateURL(task.params.url);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      outputResult({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: error.message,
        durationMs: Date.now() - startTime,
        error: 'Domain blocked',
      });
      return;
    }
  }

  // Step 6: Launch browser and execute
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        // Prevent loading of external resources not controlled by our proxy
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-domain-reliability',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'SecureClaw/1.0 (AI Assistant; +https://github.com/secureclaw)',
      viewport: { width: 1280, height: 720 },
      javaScriptEnabled: true,
    });

    // Set a reasonable default timeout
    context.setDefaultTimeout(30000);

    const page = await context.newPage();

    // Intercept all requests to enforce domain allowlist
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      try {
        const parsed = new URL(url);
        // Allow data: and blob: URLs (inline resources)
        if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
          await route.continue();
          return;
        }
        // Enforce HTTPS and domain allowlist
        if (parsed.protocol !== 'https:') {
          await route.abort('blockedbyclient');
          return;
        }
        if (!dnsProxy.isDomainAllowed(parsed.hostname)) {
          console.error(`[web-executor] Blocked request to: ${parsed.hostname}`);
          await route.abort('blockedbyclient');
          return;
        }
        // Validate DNS resolution (SSRF check)
        await dnsProxy.resolve(parsed.hostname);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });

    // Execute the requested action
    const result = await executeAction(page, task, dnsProxy);

    // Optionally capture screenshot
    let screenshotBase64: string | undefined;
    if (task.params.screenshot) {
      const buffer = await page.screenshot({ type: 'png', fullPage: false });
      screenshotBase64 = buffer.toString('base64');
    }

    // Build output
    let output = result;
    if (screenshotBase64) {
      output += `\n\n[SCREENSHOT:base64:${screenshotBase64}]`;
    }

    // Enforce output size limit
    const maxOutput = capability.maxOutputBytes || 1048576;
    if (output.length > maxOutput) {
      output = output.slice(0, maxOutput) + '\n... (output truncated)';
    }

    outputResult({
      success: true,
      exitCode: 0,
      stdout: output,
      stderr: '',
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    outputResult({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: error.message,
      durationMs: Date.now() - startTime,
      error: error.message,
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Action Execution
// ---------------------------------------------------------------------------

async function executeAction(
  page: Page,
  task: WebTask,
  dnsProxy: DNSProxy,
): Promise<string> {
  switch (task.action) {
    case 'navigate': {
      if (!task.params.url) {
        throw new Error('navigate action requires a url parameter');
      }
      await page.goto(task.params.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      // Wait for network to settle
      await page.waitForLoadState('networkidle').catch(() => {});
      return captureAccessibilityTree(page);
    }

    case 'click': {
      if (!task.params.selector) {
        throw new Error('click action requires a selector parameter');
      }
      // Try to find the element by accessibility label or text
      const selector = task.params.selector;
      try {
        // Try role-based selectors first
        await page.getByRole('link', { name: selector }).first().click({ timeout: 5000 });
      } catch {
        try {
          await page.getByRole('button', { name: selector }).first().click({ timeout: 5000 });
        } catch {
          try {
            await page.getByText(selector, { exact: false }).first().click({ timeout: 5000 });
          } catch {
            // Fall back to CSS/XPath selector
            await page.click(selector, { timeout: 10000 });
          }
        }
      }
      // Wait for navigation or content update
      await page.waitForLoadState('networkidle').catch(() => {});
      return captureAccessibilityTree(page);
    }

    case 'type': {
      if (!task.params.selector) {
        throw new Error('type action requires a selector parameter');
      }
      if (!task.params.text) {
        throw new Error('type action requires a text parameter');
      }
      const selector = task.params.selector;
      try {
        // Try to find input by placeholder or label
        await page.getByPlaceholder(selector).first().fill(task.params.text);
      } catch {
        try {
          await page.getByLabel(selector).first().fill(task.params.text);
        } catch {
          await page.fill(selector, task.params.text);
        }
      }
      return captureAccessibilityTree(page);
    }

    case 'screenshot': {
      if (task.params.url) {
        // Validate URL before navigating
        await dnsProxy.validateURL(task.params.url);
        await page.goto(task.params.url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForLoadState('networkidle').catch(() => {});
      }
      const buffer = await page.screenshot({ type: 'png', fullPage: false });
      const tree = await captureAccessibilityTree(page);
      return `${tree}\n\n[SCREENSHOT:base64:${buffer.toString('base64')}]`;
    }

    case 'extract': {
      if (task.params.url) {
        // Validate URL before navigating
        await dnsProxy.validateURL(task.params.url);
        await page.goto(task.params.url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForLoadState('networkidle').catch(() => {});
      }
      const tree = await captureAccessibilityTree(page);
      const content = await extractMainContent(page);
      return `${tree}\n\n--- Extracted Content ---\n${content}`;
    }

    default:
      throw new Error(`Unknown action: ${task.action}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outputResult(result: WebResult): void {
  console.log(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  outputResult({
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: `Fatal error: ${error.message}`,
    durationMs: 0,
    error: error.message,
  });
  process.exit(1);
});
