import {
  createToolHandler,
  defineTool,
  executeToolLocally,
  type ToolExecutionStore,
} from "../src";

interface CustomerRepository {
  findById(customerId: string, signal: AbortSignal): Promise<{ name: string } | null>;
}

export function createCustomerTools(
  customers: CustomerRepository,
  executionStore: ToolExecutionStore,
) {
  const lookupCustomer = defineTool<{ customerId: string }, { name: string } | null>({
    name: "lookup_customer",
    revision: "2026-08-30.1",
    description: "Look up a customer by ID.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["customerId"],
      additionalProperties: false,
    },
    risk: "read",
    execute({ customerId }, context) {
      return customers.findById(customerId, context.signal);
    },
  });

  return {
    lookupCustomer,
    handler: createToolHandler({
      endpoint: "https://app.example.com/api/agent-tools",
      tools: [lookupCustomer],
      executionStore,
    }),
  };
}

export async function testCustomerToolLocally(
  customers: CustomerRepository,
): Promise<{ name: string } | null> {
  const { lookupCustomer } = createCustomerTools(customers, {
    run: (_operationId, execute) => execute(),
  });
  return executeToolLocally(lookupCustomer, { customerId: "cus_123" });
}
