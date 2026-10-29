import { Type } from "typebox";

export const advisorOutputSchema = Type.Object({
  adviceId: Type.Optional(Type.String()),
  advisor: Type.Optional(Type.String()),
  followUp: Type.Optional(Type.Boolean()),
  jev: Type.Optional(
    Type.Object({
      kind: Type.Union([Type.Literal("screened"), Type.Literal("repeat")]),
      reason: Type.String(),
      skipped: Type.Boolean(),
    })
  ),
  skipReason: Type.Optional(Type.String()),
  text: Type.String({
    description: "Advisor Markdown or consultation skip notice.",
  }),
  usage: Type.Optional(
    Type.Object({
      cacheRead: Type.Optional(Type.Number()),
      cacheWrite: Type.Optional(Type.Number()),
      cost: Type.Optional(Type.Number()),
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
      totalTokens: Type.Optional(Type.Number()),
    })
  ),
});
