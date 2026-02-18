/**
 * Accessibility Tree Snapshot — compact, LLM-friendly page representation.
 *
 * Instead of sending full HTML (expensive and noisy) or screenshots
 * (requires vision model), we parse the page's accessibility tree into
 * a compact text format that gives the LLM enough structure to navigate.
 *
 * Example output:
 *   [page] Title: "GitHub - secureclaw"
 *     [heading:1] "SecureClaw"
 *     [paragraph] "A security-first personal AI agent framework"
 *     [link] "Code" → href="/secureclaw/secureclaw"
 *     [button] "Star 42"
 *     [input:text] placeholder="Search or jump to..."
 */

import type { Page } from 'playwright-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  level?: number;
  href?: string;
  placeholder?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  children?: AccessibilityNode[];
}

// ---------------------------------------------------------------------------
// Snapshot Generation
// ---------------------------------------------------------------------------

/**
 * Capture a compact accessibility tree snapshot from a Playwright page.
 *
 * Uses page.evaluate() to walk the DOM and build a semantic tree —
 * compatible with all Playwright versions (the old page.accessibility
 * API was removed in v1.42+).
 *
 * Returns a text representation optimized for LLM consumption:
 * - Low token count
 * - Semantic structure preserved
 * - Interactive elements clearly labeled
 * - Links include href targets
 */
export async function captureAccessibilityTree(
  page: Page,
  maxDepth: number = 20,
  maxNodes: number = 800,
): Promise<string> {
  const title = await page.title();
  const url = page.url();

  // Walk the DOM inside the browser and build a lightweight tree
  const tree = await page.evaluate(
    ({ maxD, maxN }: { maxD: number; maxN: number }) => {
      let count = 0;

      const ROLE_MAP: Record<string, string> = {
        A: 'link',
        BUTTON: 'button',
        INPUT: 'input',
        TEXTAREA: 'textarea',
        SELECT: 'select',
        OPTION: 'option',
        IMG: 'image',
        H1: 'heading',
        H2: 'heading',
        H3: 'heading',
        H4: 'heading',
        H5: 'heading',
        H6: 'heading',
        NAV: 'navigation',
        MAIN: 'main',
        HEADER: 'banner',
        FOOTER: 'contentinfo',
        ASIDE: 'complementary',
        SECTION: 'region',
        FORM: 'form',
        TABLE: 'table',
        THEAD: 'rowgroup',
        TBODY: 'rowgroup',
        TR: 'row',
        TH: 'columnheader',
        TD: 'cell',
        UL: 'list',
        OL: 'list',
        LI: 'listitem',
        P: 'paragraph',
        SPAN: 'text',
        STRONG: 'strong',
        EM: 'emphasis',
        B: 'strong',
        I: 'emphasis',
      };

      interface SerNode {
        role: string;
        name: string;
        value?: string;
        level?: number;
        href?: string;
        placeholder?: string;
        checked?: boolean;
        disabled?: boolean;
        children?: SerNode[];
      }

      function walk(el: Element, depth: number): SerNode | null {
        if (count >= maxN || depth > maxD) return null;

        const tag = el.tagName;
        const explicitRole = el.getAttribute('role');
        const role = explicitRole || ROLE_MAP[tag] || '';

        // Skip invisible elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return null;

        // Skip script/style/noscript
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(tag)) return null;

        const htmlEl = el as HTMLElement;
        const name =
          el.getAttribute('aria-label') ||
          el.getAttribute('alt') ||
          el.getAttribute('title') ||
          '';

        const node: SerNode = { role, name };

        // Heading level
        const hMatch = tag.match(/^H(\d)$/);
        if (hMatch) node.level = parseInt(hMatch[1], 10);

        // Link href
        if (tag === 'A') {
          node.href = (el as HTMLAnchorElement).href || undefined;
        }

        // Input specifics
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          const inp = el as HTMLInputElement;
          if (inp.type) node.role = `input:${inp.type}`;
          if (inp.placeholder) node.placeholder = inp.placeholder;
          if (inp.value) node.value = inp.value;
          if (inp.checked) node.checked = true;
          if (inp.disabled) node.disabled = true;
        }

        // Capture text content for nodes that should have it:
        // - Leaf nodes (no element children)
        // - Interactive elements (links, buttons)
        // - Inline text elements (span, strong, em, td, etc.)
        const textTags = new Set(['A', 'BUTTON', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'TD', 'TH', 'LI', 'P', 'LABEL']);
        if (!name && (el.children.length === 0 || textTags.has(tag) || explicitRole === 'button' || explicitRole === 'link')) {
          // For nodes with children, only get direct text (not all descendant text)
          // to avoid duplicating content that will appear in child nodes
          let text = '';
          if (el.children.length === 0) {
            text = htmlEl.textContent?.trim().slice(0, 120) || '';
          } else {
            // Get only direct text nodes (not text inside child elements)
            for (const child of Array.from(el.childNodes)) {
              if (child.nodeType === Node.TEXT_NODE) {
                const t = child.textContent?.trim();
                if (t) text += (text ? ' ' : '') + t;
              }
            }
            text = text.slice(0, 120);
          }
          if (text) node.name = text;
        }

        count++;

        // Walk children
        const children: SerNode[] = [];
        for (const child of Array.from(el.children)) {
          const c = walk(child, depth + 1);
          if (c) children.push(c);
        }
        if (children.length > 0) node.children = children;

        // Prune truly empty containers with no semantic role and no children
        if (!role && !node.name && !node.value && children.length === 0) {
          return null;
        }

        // Flatten: if a DIV/SPAN wrapper with no role/name and only one child, promote
        const wrapperTags = new Set(['DIV', 'SPAN', 'CENTER']);
        if (!role && !node.name && children.length === 1 && wrapperTags.has(tag)) {
          return children[0];
        }

        return node;
      }

      const root = walk(document.body, 0);
      return root;
    },
    { maxD: maxDepth, maxN: maxNodes },
  );

  if (!tree) {
    return `[page] Title: "${title}"\n  URL: ${url}\n  (empty or inaccessible page)`;
  }

  const lines: string[] = [];
  lines.push(`[page] Title: "${title}"`);
  lines.push(`  URL: ${url}`);

  let nodeCount = 0;

  function render(node: AccessibilityNode, depth: number): void {
    if (nodeCount >= maxNodes || depth > maxDepth) return;
    nodeCount++;

    const indent = '  '.repeat(depth);
    const line = formatNode(node);

    if (line) {
      lines.push(`${indent}${line}`);
    }

    if (node.children) {
      for (const child of node.children) {
        render(child, depth + 1);
      }
    }
  }

  if (tree.children) {
    for (const child of tree.children as AccessibilityNode[]) {
      render(child, 1);
    }
  } else {
    render(tree as AccessibilityNode, 1);
  }

  if (nodeCount >= maxNodes) {
    lines.push(`  ... (truncated at ${maxNodes} nodes)`);
  }

  return lines.join('\n');
}

/**
 * Format a single accessibility node into a compact text representation.
 */
function formatNode(node: AccessibilityNode): string | null {
  const { role, name, value } = node;

  // Skip generic/container roles with no useful info
  if (role === 'none' || role === 'generic' || role === 'presentation') {
    return null;
  }

  // Skip empty text nodes
  if (role === 'text' && !name?.trim()) {
    return null;
  }

  let tag = `[${role}`;

  // Add level for headings
  if (node.level !== undefined) {
    tag += `:${node.level}`;
  }

  tag += ']';

  // Build the content string
  const parts: string[] = [];

  if (name) {
    parts.push(`"${truncate(name, 120)}"`);
  }

  if (value && value !== name) {
    parts.push(`value="${truncate(value, 80)}"`);
  }

  if (node.href) {
    parts.push(`→ href="${truncate(node.href, 100)}"`);
  }

  if (node.placeholder) {
    parts.push(`placeholder="${node.placeholder}"`);
  }

  if (node.checked !== undefined) {
    parts.push(node.checked ? 'checked' : 'unchecked');
  }

  if (node.selected) {
    parts.push('selected');
  }

  if (node.expanded !== undefined) {
    parts.push(node.expanded ? 'expanded' : 'collapsed');
  }

  if (node.disabled) {
    parts.push('disabled');
  }

  return `${tag} ${parts.join(' ')}`.trim();
}

/**
 * Extract interactive elements from the page for targeted actions.
 * Returns elements that can be clicked, typed into, etc.
 */
export async function getInteractiveElements(
  page: Page,
): Promise<Array<{ role: string; name: string; selector: string }>> {
  return page.evaluate(() => {
    const elements: Array<{ role: string; name: string; selector: string }> = [];
    const interactiveSelectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[onclick]',
    ];

    const allElements = document.querySelectorAll(interactiveSelectors.join(','));

    allElements.forEach((el, index) => {
      const htmlEl = el as HTMLElement;
      const role = htmlEl.getAttribute('role') || htmlEl.tagName.toLowerCase();
      const name =
        htmlEl.getAttribute('aria-label') ||
        htmlEl.textContent?.trim().slice(0, 80) ||
        htmlEl.getAttribute('placeholder') ||
        htmlEl.getAttribute('title') ||
        `element-${index}`;

      // Build a reasonable selector
      let selector = '';
      if (htmlEl.id) {
        selector = `#${htmlEl.id}`;
      } else if (htmlEl.getAttribute('aria-label')) {
        selector = `[aria-label="${htmlEl.getAttribute('aria-label')}"]`;
      } else if (role === 'a' && htmlEl.getAttribute('href')) {
        selector = `a[href="${htmlEl.getAttribute('href')}"]`;
      } else {
        selector = `${htmlEl.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
      }

      elements.push({ role, name, selector });
    });

    return elements.slice(0, 200);
  });
}

/**
 * Extract the main text content from a page.
 * Useful for "extract" actions that just want readable text.
 */
export async function extractMainContent(
  page: Page,
  maxLength: number = 10000,
): Promise<string> {
  return page.evaluate((limit: number) => {
    // Try to find the main content area
    const main =
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('article') ||
      document.querySelector('#content') ||
      document.querySelector('.content') ||
      document.body;

    if (!main) return '(no content found)';

    // Get text content, cleaning up excessive whitespace
    const text = main.textContent || '';
    const cleaned = text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned.slice(0, limit);
  }, maxLength);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
