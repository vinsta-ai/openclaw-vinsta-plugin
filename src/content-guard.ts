/**
 * Content screening for the OpenClaw-Vinsta bridge.
 *
 * Provides inbound screening (social engineering detection) and outbound
 * screening (sensitive data leakage detection) with configurable patterns.
 */

export type ScreenResult = {
  allowed: boolean;
  reason?: string;
  severity: "block" | "warn" | "pass";
};

const MAX_CUSTOM_PATTERN_LENGTH = 500;
const EXTRACTION_VERB = String.raw`(?:tell|show|send|share|give|reveal|provide|forward)`;
const EXTRACTION_REQUEST_PREFIX = String.raw`(?:what(?:'s| is)|${EXTRACTION_VERB}|(?:can|could|would)\s+you\s+${EXTRACTION_VERB})`;

function buildInboundExtractionPattern(target: string) {
  return new RegExp(
    String.raw`\b${EXTRACTION_REQUEST_PREFIX}\s+(?:me\s+)?(?:your|the)\s+(?:\w+\s+){0,8}(?:${target})\b`,
    "i",
  );
}

// ---------------------------------------------------------------------------
// Default patterns
// ---------------------------------------------------------------------------

const DEFAULT_INBOUND_PATTERNS: RegExp[] = [
  // Bank / financial info
  buildInboundExtractionPattern(
    String.raw`bank\s*account(?:\s*number)?|routing\s*number|wire\s*transfer|iban|swift\s*code`,
  ),
  // SSN
  buildInboundExtractionPattern(String.raw`social\s*security\s*(?:number)?|ssn`),
  // Passwords / credentials
  buildInboundExtractionPattern(String.raw`password|passwd|passphrase|master\s*password`),
  // API keys / tokens
  buildInboundExtractionPattern(
    String.raw`api\s*key|secret\s*key|access\s*token|auth\s*token|bearer\s*token`,
  ),
  // Crypto seed phrases / private keys
  buildInboundExtractionPattern(
    String.raw`seed\s*phrase|mnemonic\s*phrase|recovery\s*phrase|private\s*key|wallet\s*key`,
  ),
  // Credit cards
  buildInboundExtractionPattern(
    String.raw`credit\s*card|card\s*number|cvv|cvc|expir(?:y|ation)\s*date`,
  ),
  // Direct extraction attempts
  buildInboundExtractionPattern(String.raw`secret|credentials?`),
  // Social engineering patterns
  /\b(?:pretend\s*(?:you\s*are|to\s*be)|ignore\s*(?:(?:all\s+)?previous|all)\s*instructions|bypass\s*(?:security|safety))\b/i,
];

const DEFAULT_OUTBOUND_PATTERNS: RegExp[] = [
  // Credit card numbers (4 groups of 4 digits)
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  // SSN pattern
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Private key headers
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  // JWT tokens (three base64 segments separated by dots)
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // Long hex strings that look like secrets (128+ chars — 64-char hex is common
  // in SHA-256 hashes, git commit SHAs, etc., so we only flag truly long ones)
  /\b[0-9a-f]{128,}\b/i,
  // Long base64 strings that look like secrets (80+ chars — shorter sequences
  // are common in URLs, encoded payloads, and normal agent output)
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/,
  // AWS-style keys
  /\bAKIA[A-Z0-9]{16}\b/,
  // Ethereum private keys
  /\b0x[0-9a-fA-F]{64}\b/,
];

// ---------------------------------------------------------------------------
// Screening functions
// ---------------------------------------------------------------------------

function compilePatterns(raw: string[]): RegExp[] {
  return raw
    .filter((pattern) => pattern.trim())
    .filter((pattern) => pattern.length <= MAX_CUSTOM_PATTERN_LENGTH)
    .map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch {
        return null;
      }
    })
    .filter((regex): regex is RegExp => regex !== null);
}

/**
 * Screen an inbound message for social engineering / extraction attempts.
 */
export function screenInbound(
  message: string,
  customPatterns?: string[],
): ScreenResult {
  if (!message.trim()) {
    return { allowed: true, severity: "pass" };
  }

  const patterns = [
    ...DEFAULT_INBOUND_PATTERNS,
    ...(customPatterns ? compilePatterns(customPatterns) : []),
  ];

  for (const pattern of patterns) {
    if (pattern.test(message)) {
      return {
        allowed: false,
        reason: `Inbound message matched a blocked pattern: ${pattern.source}`,
        severity: "block",
      };
    }
  }

  return { allowed: true, severity: "pass" };
}

/**
 * Screen an outbound reply for sensitive data leakage.
 */
export function screenOutbound(
  reply: string,
  customPatterns?: string[],
): ScreenResult {
  if (!reply.trim()) {
    return { allowed: true, severity: "pass" };
  }

  const patterns = [
    ...DEFAULT_OUTBOUND_PATTERNS,
    ...(customPatterns ? compilePatterns(customPatterns) : []),
  ];

  for (const pattern of patterns) {
    if (pattern.test(reply)) {
      return {
        allowed: false,
        reason: `Outbound reply matched a sensitive data pattern: ${pattern.source}`,
        severity: "block",
      };
    }
  }

  return { allowed: true, severity: "pass" };
}
