import { z } from "zod";
import { HydraTool } from "../../../types.js";

export const calculatorTool: HydraTool = {
  name: "calculator",
  description: "A basic calculator that evaluates mathematical expressions.",
  schema: z.object({
    expression: z
      .string()
      .describe('The mathematical expression to evaluate (e.g., "2 + 2")'),
  }),
  execute: async ({ expression }) => {
    try {
      console.log(`[Tool: Calculator] Evaluating: ${expression}`);
      // Security warning: eval is used here purely as a minimal example for users.
      // In a real addon, consider using a safe math parser (e.g. mathjs).
      const result = eval(expression);
      return `The result is: ${result}`;
    } catch (e: any) {
      return `Error evaluating expression: ${e.message}`;
    }
  },
};
