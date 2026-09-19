/**
 * Encoding detection for reading user text files (.md / .txt).
 *
 * Implementation lives at `@orison/shared-contracts/fs/decodeText` — the pure
 * function core is shared with the agent / local-bff read paths so every
 * consumer decodes with the same detection order (BOM → UTF-16 sniff → strict
 * UTF-8 → GBK) and the same LF newline normalization. This module keeps the
 * shell import surface (`main/fs/decodeText`) stable for existing callers and
 * the decodeText test suite.
 */
export { decodeFileToUtf8 } from '@orison/shared-contracts/fs/decodeText';
