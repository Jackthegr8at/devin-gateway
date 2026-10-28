import type { OpenAIMessage, ResponsesToolIdentity } from "./convert.js";

export function withNativeWebSearchUnavailable(instructions: string): string {
  const notice = "[Gateway unavailable capability]\nNative hosted web_search is unavailable in this provider session. Do not invoke it or claim to have browsed using it. Use only currently declared tools. If the task requires native web_search, explain that this capability is unavailable; do not invent a substitute.";
  return instructions ? `${instructions}\n\n${notice}` : notice;
}

/** Historical tools are context, not a declaration of current capabilities. */
export function withHistoricalToolGuidance(
  instructions: string,
  history: readonly OpenAIMessage[],
  declaredTools: ReadonlyMap<string, ResponsesToolIdentity>,
): string {
  if (!history.some((message) => message.tool_calls?.some((call) => !declaredTools.has(call.function.name)
    && !(message.historicalToolIdentity && [...declaredTools.values()].some(identity => identity.name === message.historicalToolIdentity!.name && identity.namespace === message.historicalToolIdentity!.namespace))))) {
    return instructions;
  }
  const guidance = "[Gateway current tool capabilities]\nHistorical tool calls and results are records of previous actions only, not currently available capabilities. Earlier instructions and tool usage may describe another provider. Invoke only tool names declared in the current request; use their current schemas, not historical tool inputs. Do not repeat historical calls merely because they appear in the conversation. Continue the user's task using the current capabilities."
    + (declaredTools.has("exec_command") ? " The currently declared shell execution tool is exec_command; use its declared schema for shell commands." : "");
  return instructions ? `${instructions}\n\n${guidance}` : guidance;
}
