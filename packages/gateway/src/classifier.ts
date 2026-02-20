/**
 * Action Classification Engine — determines the HITL tier for each tool call.
 *
 * CRITICAL: Classification is done entirely in code based on the YAML config.
 * The LLM never sees the tier system and does NOT self-classify.
 *
 * Rules are checked in order: autoApprove → notify → requireApproval.
 * Each rule matches on tool name and optional conditions (glob patterns).
 * If no rule matches, the default is 'require-approval' (fail-safe).
 *
 * Phase 8: Returns { tier, explicit } to distinguish explicit rule matches
 * from the fail-safe default. This allows MCP server defaultTier to apply
 * only when no explicit rule is configured.
 */

import picomatch from 'picomatch';
import type { ActionTier } from '@secureclaw/shared';
import type { ActionCondition, SecureClawConfig } from './config.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Classification result including whether an explicit rule matched. */
export interface ClassificationResult {
  tier: ActionTier;
  /**
   * True if an explicit rule in the config matched this tool call.
   * False if the fail-safe default was used (no rule matched).
   *
   * This distinction matters for MCP tools: when no explicit rule is
   * configured, the MCP server's defaultTier should apply instead of
   * the fail-safe require-approval.
   */
  explicit: boolean;
}

/**
 * Classify a tool call into an action tier based on config rules.
 *
 * @param toolName - The tool being called (e.g., 'write_file')
 * @param toolInput - The tool call arguments from the LLM
 * @param config - The loaded SecureClaw configuration
 * @returns The classification result with tier and whether a rule explicitly matched
 */
export function classifyAction(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: SecureClawConfig,
): ClassificationResult {
  const tiers: Array<{ tier: ActionTier; rules: ActionCondition[] }> = [
    { tier: 'auto-approve', rules: config.actionTiers.autoApprove },
    { tier: 'notify', rules: config.actionTiers.notify },
    { tier: 'require-approval', rules: config.actionTiers.requireApproval },
  ];

  for (const { tier, rules } of tiers) {
    for (const rule of rules) {
      if (matchesRule(rule, toolName, toolInput)) {
        return { tier, explicit: true };
      }
    }
  }

  // Fail-safe default: require approval for any unclassified action
  return { tier: 'require-approval', explicit: false };
}

// ---------------------------------------------------------------------------
// Matching Logic
// ---------------------------------------------------------------------------

/**
 * Check if a rule matches a tool call.
 *
 * A rule matches if:
 * 1. The tool name matches exactly
 * 2. All conditions (if any) match the corresponding tool input fields
 */
function matchesRule(
  rule: ActionCondition,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // Tool name must match exactly
  if (rule.tool !== toolName) return false;

  // If no conditions, tool name match is sufficient
  if (!rule.conditions) return true;

  // All conditions must match
  return Object.entries(rule.conditions).every(([field, pattern]) =>
    matchesCondition(field, pattern, toolInput),
  );
}

/**
 * Check if a single condition matches against the tool input.
 *
 * The condition field is looked up in the tool input. If the field
 * is missing from the tool input, the condition does NOT match
 * (safe default — no match means the rule doesn't apply).
 */
function matchesCondition(
  field: string,
  pattern: string,
  toolInput: Record<string, unknown>,
): boolean {
  const value = toolInput[field];

  // If the field is not present in tool input, condition doesn't match.
  // This is the safe default: missing fields don't trigger any rule,
  // which means the action falls through to the fail-safe require-approval.
  if (value === undefined || value === null) return false;

  const stringValue = String(value);

  return matchesPattern(stringValue, pattern);
}

/**
 * Match a string value against a glob pattern.
 *
 * Supports:
 * - Standard glob patterns: /sandbox/*, /workspace/**
 * - Negation patterns: !(/sandbox/*) — matches anything NOT in /sandbox
 *
 * Uses picomatch for robust glob matching with dot: true to match
 * dotfiles and paths containing dots.
 */
export function matchesPattern(value: string, pattern: string): boolean {
  // Handle negation syntax: !(inner_pattern)
  if (pattern.startsWith('!(') && pattern.endsWith(')')) {
    const innerPattern = pattern.slice(2, -1);
    return !picomatch.isMatch(value, innerPattern, { dot: true });
  }

  return picomatch.isMatch(value, pattern, { dot: true });
}
