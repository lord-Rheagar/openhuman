import { createContext, useContext } from 'react';

import type { useComposerDictation } from './useComposerDictation';

export type ComposerDictationState = ReturnType<typeof useComposerDictation>;

export const ComposerDictationContext = createContext<ComposerDictationState | null>(null);

export function useComposerDictationState(): ComposerDictationState | null {
  return useContext(ComposerDictationContext);
}
