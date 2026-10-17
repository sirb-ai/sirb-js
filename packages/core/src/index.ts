/** npm package name, kept in sync with package.json by the test suite. */
export const packageName = "@sirb/core";

export {
  loadSpec,
  loadSpecFile,
  loadSpecOrThrow,
  validateSpec,
  type LoadSpecFileOptions,
  type LoadSpecOptions,
  type LoadSpecResult,
  type SpecFormat,
  type ValidateSpecResult,
} from "./load.js";
export {
  defineAgent,
  type AgentInput,
  type DefineAgentOptions,
} from "./define-agent.js";
export {
  SirbSpecError,
  type SpecIssue,
  type SpecIssueCode,
  type SpecIssueSeverity,
} from "./issues.js";
export type * from "./types.js";
