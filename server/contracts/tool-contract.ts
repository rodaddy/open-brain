/**
 * The shape every entry in the tool-contract mirror takes.
 *
 * Split out of the single-file mirror (issue 864) so each tool-group file can
 * declare its own slice of `TOOL_CONTRACTS` against one shared type.
 */
export interface ToolContract {
  version: number;
  input_schema: unknown;
  output_shape: string;
}
