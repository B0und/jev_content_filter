import textComparison from './text-comparison.json';
import imageComparison from './image-comparison.json';
import { normalizeBenchmarkState } from './model';

export function measuredComparisons() {
  return normalizeBenchmarkState({
    cases: [...textComparison.cases, ...imageComparison.cases],
    solutions: [...textComparison.solutions, ...imageComparison.solutions],
  });
}
