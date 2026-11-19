import { lengthPrefixed, utf8 } from "./encoding";

/**
 * Where a ciphertext belongs (Keys.md "Associated data"). Writers choose record IDs before encrypting,
 * so none of these depend on an ID Convex assigns later. Use `""` for a part that does not apply.
 */
export type AadParts = {
  table: string;
  workspace: string;
  parent: string;
  record: string;
  field: string;
};

const AAD_PREFIX = "radium/v1";

/**
 * Encodes AAD as the length-prefixed (u32 big-endian) concatenation of `radium/v1`, table, workspace,
 * parent, record and field. Moving a ciphertext to another table, workspace, parent, record or field
 * changes these bytes and fails decryption.
 */
export function buildAad(parts: AadParts): Uint8Array {
  return lengthPrefixed([
    utf8(AAD_PREFIX),
    utf8(parts.table),
    utf8(parts.workspace),
    utf8(parts.parent),
    utf8(parts.record),
    utf8(parts.field),
  ]);
}
