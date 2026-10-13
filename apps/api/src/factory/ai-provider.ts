/**
 * The ONLY seam to a model. Domain code never imports a provider SDK; it asks the gateway, which asks this port.
 * Plugging in the real model later means writing one class that implements AiProvider and choosing it in
 * createAiProvider. Nothing else changes.
 */
import { MockAiProvider, parseMockFaults } from './mock-provider';

export interface AiRequest {
  role: string;
  system: string;
  /** JSON text of the structured input. */
  user: string;
  maxOutputTokens: number;
}

export interface AiResponse {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(req: AiRequest): Promise<AiResponse>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

/**
 * AI_PROVIDER=mock is a built-in stand-in whose questions are placeholders; it is refused in production.
 * No real provider is built yet: asking for one fails loudly instead of quietly using the mock.
 */
export function createAiProvider(env: Record<string, string | undefined> = process.env): AiProvider {
  const which = env.AI_PROVIDER?.trim().toLowerCase();
  if (!which) throw new Error('AI_PROVIDER is not set. Use AI_PROVIDER=mock to try the pipeline with placeholder questions.');
  if (which === 'mock') {
    if (env.NODE_ENV === 'production') throw new Error('AI_PROVIDER=mock is not permitted when NODE_ENV=production');
    return new MockAiProvider(parseMockFaults(env.MOCK_AI_FAULTS));
  }
  throw new Error(`AI_PROVIDER=${which} is not built yet. Only "mock" exists; a real provider is added by implementing AiProvider.`);
}
