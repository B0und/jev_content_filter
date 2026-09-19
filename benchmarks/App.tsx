import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  createId,
  createSolution,
  exportBenchmarkState,
  formatMetric,
  initialBenchmarkState,
  manualReviewFor,
  metricsFor,
  NSFWJS_LABELS,
  parseSolutionImport,
  predictionFor,
  predictionLabel,
  predictionScore,
  SOLUTION_KIND_LABELS,
  TASK_LABELS,
  type BenchmarkCase,
  type BenchmarkModality,
  type BenchmarkState,
  type BenchmarkTask,
  type NsfwjsTask,
  type ReviewVerdict,
  type ScoreKey,
  type SolutionKind,
  type TruthValue,
} from './model';
import { loadBenchmarkState, saveBenchmarkState } from './storage';
import './styles.css';

type CaseFilter = 'all' | BenchmarkModality;

const TASKS: BenchmarkTask[] = ['explicit', 'aiGenerated'];
const NSFWJS_TASKS: NsfwjsTask[] = ['porn', 'hentai', 'sexy', 'drawings'];
const SOLUTION_KINDS: SolutionKind[] = ['llm', 'nsfwjs', 'other'];
const TRUTH_OPTIONS: Array<{ value: TruthValue; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unknown', label: 'Unknown' },
];
function isNsfwjsTask(task: ScoreKey): task is NsfwjsTask {
  return NSFWJS_TASKS.includes(task as NsfwjsTask);
}

function readFileAsDataUrl(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') resolve(reader.result);
    else reject(new Error('Could not read the image file.'));
  };
  reader.onerror = () => reject(new Error('Could not read the image file.'));
  reader.readAsDataURL(file);
  return promise;
}

function formatCaseLabel(item: BenchmarkCase): string {
  return item.labels.explicit === 'unknown' && item.labels.aiGenerated === 'unknown'
    ? 'Needs labels'
    : `${item.labels.explicit === 'unknown' ? '—' : item.labels.explicit === 'yes' ? 'Explicit' : 'Safe'} · ${item.labels.aiGenerated === 'unknown' ? '—' : item.labels.aiGenerated === 'yes' ? 'AI' : 'Human'}`;
}

function MetricCell({ value }: { value: number | null }) {
  return <td className={value === null ? 'muted-cell' : undefined}>{formatMetric(value)}</td>;
}

export function App() {
  const [state, setState] = useState<BenchmarkState>(() => initialBenchmarkState());
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [filter, setFilter] = useState<CaseFilter>('all');
  const [solutionDraft, setSolutionDraft] = useState('');
  const [solutionKind, setSolutionKind] = useState<SolutionKind>('llm');
  const [sampleType, setSampleType] = useState<BenchmarkModality>('text');
  const [sampleTitle, setSampleTitle] = useState('');
  const [sampleText, setSampleText] = useState('');
  const [sampleImage, setSampleImage] = useState('');
  const [sampleFileName, setSampleFileName] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    void loadBenchmarkState()
      .then((loaded) => {
        if (cancelled) return;
        setState(loaded);
        setStorageError('');
        setStorageReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStorageError(error instanceof Error ? error.message : 'SQLite storage is unavailable.');
        setStorageReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    void saveBenchmarkState(state)
      .then(() => setStorageError(''))
      .catch((error: unknown) => {
        setStorageError(error instanceof Error ? error.message : 'SQLite storage is unavailable.');
      });
  }, [state, storageReady]);

  const selectedCase =
    state.cases.find((item) => item.id === state.selectedCaseId) ?? state.cases[0];
  const visibleCases = useMemo(
    () => state.cases.filter((item) => filter === 'all' || item.modality === filter),
    [filter, state.cases],
  );
  const labeledCount = selectedCase
    ? TASKS.filter((task) => selectedCase.labels[task] !== 'unknown').length
    : 0;

  function selectCase(id: string) {
    setState((current) => ({ ...current, selectedCaseId: id }));
  }

  function updateCaseLabels(task: BenchmarkTask, value: TruthValue) {
    if (!selectedCase) return;
    setState((current) => ({
      ...current,
      cases: current.cases.map((item) =>
        item.id === selectedCase.id ? { ...item, labels: { ...item.labels, [task]: value } } : item,
      ),
    }));
  }

  function updateThreshold(task: BenchmarkTask | 'nsfwjs', value: string) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    setState((current) => ({
      ...current,
      thresholds: { ...current.thresholds, [task]: Math.min(1, Math.max(0, numeric)) },
    }));
  }

  function updatePrediction(solutionId: string, task: ScoreKey, value: string) {
    const numeric = value === '' ? null : Number(value);
    if (numeric !== null && (!Number.isFinite(numeric) || numeric < 0 || numeric > 1)) return;
    const caseId = selectedCase?.id ?? '';
    setState((current) => ({
      ...current,
      solutions: current.solutions.map((solution) => {
        if (solution.id !== solutionId) return solution;
        const previous = predictionFor(solution, caseId);
        const review =
          numeric === null
            ? { ...previous.review, [task]: 'unreviewed' as const }
            : previous.review;
        const prediction = isNsfwjsTask(task)
          ? { ...previous, nsfwjs: { ...previous.nsfwjs, [task]: numeric }, review }
          : { ...previous, [task]: numeric, review };
        return {
          ...solution,
          predictions: { ...solution.predictions, [caseId]: prediction },
        };
      }),
    }));
  }

  function updateReview(solutionId: string, task: ScoreKey, verdict: ReviewVerdict) {
    const caseId = selectedCase?.id ?? '';
    setState((current) => ({
      ...current,
      solutions: current.solutions.map((solution) => {
        if (solution.id !== solutionId) return solution;
        const previous = predictionFor(solution, caseId);
        if (predictionScore(previous, task) === null) return solution;
        return {
          ...solution,
          predictions: {
            ...solution.predictions,
            [caseId]: {
              ...previous,
              review: { ...previous.review, [task]: verdict },
            },
          },
        };
      }),
    }));
  }
  function renderPredictionCell(solution: BenchmarkState['solutions'][number], task: ScoreKey) {
    const prediction = predictionFor(solution, selectedCase?.id ?? '');
    const value = predictionScore(prediction, task);
    const threshold = isNsfwjsTask(task) ? state.thresholds.nsfwjs : state.thresholds[task];
    const label = isNsfwjsTask(task) ? NSFWJS_LABELS[task] : TASK_LABELS[task];
    const stateLabel = predictionLabel(value, threshold);
    const verdict = prediction.review[task];
    return (
      <td key={task}>
        <div className="score-editor">
          <input
            aria-label={`${solution.name} ${label} score`}
            data-testid={`${solution.id}-${task}-score`}
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={value ?? ''}
            placeholder="—"
            onChange={(event) => updatePrediction(solution.id, task, event.target.value)}
          />
          <span className={`prediction-state ${stateLabel}`}>{stateLabel}</span>
        </div>
        <div className="score-review" aria-label={`${solution.name} ${label} manual review`}>
          <button
            type="button"
            className={`review-button right ${verdict === 'right' ? 'selected' : ''}`}
            aria-label={`Mark ${solution.name} ${label} right`}
            aria-pressed={verdict === 'right'}
            data-testid={`${solution.id}-${task}-review-right`}
            disabled={value === null}
            onClick={() => updateReview(solution.id, task, 'right')}
          >
            Right
          </button>
          <button
            type="button"
            className={`review-button wrong ${verdict === 'wrong' ? 'selected' : ''}`}
            aria-label={`Mark ${solution.name} ${label} wrong`}
            aria-pressed={verdict === 'wrong'}
            data-testid={`${solution.id}-${task}-review-wrong`}
            disabled={value === null}
            onClick={() => updateReview(solution.id, task, 'wrong')}
          >
            Wrong
          </button>
          {verdict !== 'unreviewed' && (
            <button
              type="button"
              className="review-button clear"
              aria-label={`Clear ${solution.name} ${label} review`}
              data-testid={`${solution.id}-${task}-review-clear`}
              onClick={() => updateReview(solution.id, task, 'unreviewed')}
            >
              Clear
            </button>
          )}
        </div>
      </td>
    );
  }

  function addSolution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = solutionDraft.trim();
    if (!name) return;
    setState((current) => ({
      ...current,
      solutions: [...current.solutions, createSolution(name, '', solutionKind)],
    }));
    setSolutionDraft('');
    setNotice(`Added ${name}. Enter scores here or import a full result set.`);
  }

  function removeSolution(solutionId: string) {
    setState((current) => ({
      ...current,
      solutions: current.solutions.filter((solution) => solution.id !== solutionId),
    }));
    setNotice('Solution removed from this local benchmark.');
  }

  async function importSolution(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const solution = parseSolutionImport(await file.text());
      setState((current) => ({ ...current, solutions: [...current.solutions, solution] }));
      setNotice(`Imported ${solution.name}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import that solution.');
    }
  }

  function exportDataset() {
    const blob = new Blob([exportBenchmarkState(state)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'jev-benchmark-state.json';
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice('Benchmark state exported.');
  }

  async function addSample(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = sampleTitle.trim();
    if (!title) {
      setNotice('Give the sample a short title first.');
      return;
    }
    if (sampleType === 'image' && !sampleImage) {
      setNotice('Choose an image before adding this sample.');
      return;
    }
    if (sampleType === 'text' && !sampleText.trim()) {
      setNotice('Paste some text before adding this sample.');
      return;
    }
    const item: BenchmarkCase = {
      id: createId('case'),
      modality: sampleType,
      title,
      imageUrl: sampleType === 'image' ? sampleImage : undefined,
      text: sampleType === 'text' ? sampleText.trim() : undefined,
      labels: { explicit: 'unknown', aiGenerated: 'unknown' },
      notes: sampleFileName ? `Imported from ${sampleFileName}.` : '',
      createdAt: new Date().toISOString(),
    };
    setState((current) => ({
      ...current,
      cases: [item, ...current.cases],
      selectedCaseId: item.id,
    }));
    setSampleTitle('');
    setSampleText('');
    setSampleImage('');
    setSampleFileName('');
    setNotice(`Added ${title}. Mark the human labels before comparing models.`);
  }

  async function chooseSampleImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setSampleImage(await readFileAsDataUrl(file));
      setSampleFileName(file.name);
      setNotice(`${file.name} ready to add.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not read the image.');
    }
  }

  if (!storageReady) {
    return (
      <main className="storage-loading" data-testid="benchmark-storage-loading">
        <p className="eyebrow">Local evaluation workbench</p>
        <h1>Benchmark Lab</h1>
        <p>Connecting to the SQLite database…</p>
      </main>
    );
  }

  return (
    <div className="lab-shell" data-testid="benchmark-app">
      <header className="lab-header">
        <div className="lab-mark" aria-hidden="true">
          BL
        </div>
        <div>
          <p className="eyebrow">Local evaluation workbench</p>
          <h1>Benchmark Lab</h1>
          <p className="lede">Label once. Run many solutions. Keep the mistakes visible.</p>
          <output
            className={`storage-status ${storageError ? 'error' : ''}`}
            data-testid="storage-status"
          >
            {storageError ? `SQLite storage error: ${storageError}` : 'SQLite database connected'}
          </output>
        </div>
        <div className="header-actions">
          <button type="button" className="quiet-button" onClick={exportDataset}>
            Export state
          </button>
          <label className="button-label">
            Import solution
            <input type="file" accept="application/json,.json" onChange={importSolution} />
          </label>
        </div>
      </header>

      <section className="lab-strip" aria-label="Benchmark overview">
        <div className="strip-stat">
          <strong>{state.cases.length}</strong>
          <span>cases</span>
        </div>
        <div className="strip-stat">
          <strong>{state.cases.filter((item) => item.modality === 'image').length}</strong>
          <span>images</span>
        </div>
        <div className="strip-stat">
          <strong>{state.cases.filter((item) => item.modality === 'text').length}</strong>
          <span>text samples</span>
        </div>
        <div className="strip-stat">
          <strong>{state.solutions.length}</strong>
          <span>solutions</span>
        </div>
        <div className="thresholds">
          <span>Decision thresholds</span>
          {TASKS.map((task) => (
            <label key={task}>
              {TASK_LABELS[task]}
              <input
                aria-label={`${TASK_LABELS[task]} threshold`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={state.thresholds[task]}
                onChange={(event) => updateThreshold(task, event.target.value)}
              />
            </label>
          ))}
          <label>
            NSFWJS
            <input
              aria-label="NSFWJS threshold"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={state.thresholds.nsfwjs}
              onChange={(event) => updateThreshold('nsfwjs', event.target.value)}
            />
          </label>
        </div>
      </section>

      <main className="lab-grid">
        <aside className="case-rail" aria-label="Benchmark cases">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">Dataset</p>
              <h2>Review queue</h2>
            </div>
            <span className="case-count">{visibleCases.length}</span>
          </div>
          <div className="filter-tabs" role="tablist" aria-label="Filter cases">
            {(['all', 'image', 'text'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={filter === value ? 'active' : ''}
                onClick={() => setFilter(value)}
              >
                {value === 'all' ? 'All' : value === 'image' ? 'Images' : 'Text'}
              </button>
            ))}
          </div>
          <div className="case-list">
            {visibleCases.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`case-row ${selectedCase?.id === item.id ? 'selected' : ''}`}
                onClick={() => selectCase(item.id)}
              >
                <span className={`modality-dot ${item.modality}`} aria-hidden="true" />
                <span className="case-row-copy">
                  <strong>{item.title}</strong>
                  <small>{formatCaseLabel(item)}</small>
                </span>
                <span className="case-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
          <details className="add-sample">
            <summary>Add a sample</summary>
            <form onSubmit={addSample}>
              <label>
                Type
                <select
                  value={sampleType}
                  onChange={(event) => setSampleType(event.target.value as BenchmarkModality)}
                >
                  <option value="text">Text</option>
                  <option value="image">Image</option>
                </select>
              </label>
              <label>
                Title
                <input
                  value={sampleTitle}
                  onChange={(event) => setSampleTitle(event.target.value)}
                  placeholder="Short review title"
                />
              </label>
              {sampleType === 'text' ? (
                <label>
                  Text
                  <textarea
                    value={sampleText}
                    onChange={(event) => setSampleText(event.target.value)}
                    rows={4}
                    placeholder="Paste the text to benchmark"
                  />
                </label>
              ) : (
                <label className="file-field">
                  Image
                  <input type="file" accept="image/*" onChange={chooseSampleImage} />
                  {sampleFileName && <small>{sampleFileName}</small>}
                </label>
              )}
              <button type="submit" className="primary-button">
                Add sample
              </button>
            </form>
          </details>
        </aside>

        <section className="review-column">
          {selectedCase ? (
            <>
              <div className="review-heading">
                <div>
                  <div className="case-kicker">
                    <span className={`modality-pill ${selectedCase.modality}`}>
                      {selectedCase.modality}
                    </span>
                    <span>{selectedCase.id}</span>
                  </div>
                  <h2>{selectedCase.title}</h2>
                  <p>{selectedCase.notes || 'No notes yet.'}</p>
                </div>
                <div className="label-progress">
                  <strong>{labeledCount}/2</strong>
                  <span>human labels set</span>
                </div>
              </div>

              <div className="sample-review">
                <div className={`sample-stage ${selectedCase.modality}`}>
                  {selectedCase.modality === 'image' && selectedCase.imageUrl ? (
                    <img src={selectedCase.imageUrl} alt={selectedCase.title} />
                  ) : (
                    <blockquote>{selectedCase.text}</blockquote>
                  )}
                </div>
                <div className="label-panel">
                  <p className="eyebrow">Human ground truth</p>
                  <h3>What should a good filter decide?</h3>
                  <p className="label-help">
                    Unknown keeps this case out of that task’s metrics until you decide.
                  </p>
                  {TASKS.map((task) => (
                    <fieldset key={task} className="truth-fieldset">
                      <legend>{TASK_LABELS[task]}</legend>
                      <div className="truth-options">
                        {TRUTH_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={
                              selectedCase.labels[task] === option.value
                                ? `selected ${option.value}`
                                : ''
                            }
                            aria-pressed={selectedCase.labels[task] === option.value}
                            data-testid={`case-label-${task}-${option.value}`}
                            onClick={() => updateCaseLabels(task, option.value)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
              </div>

              <section className="solutions-section" aria-label="Solution comparison">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Same cases, same labels</p>
                    <h2>Compare solutions</h2>
                  </div>
                  <form className="add-solution" onSubmit={addSolution}>
                    <input
                      aria-label="Solution name"
                      value={solutionDraft}
                      onChange={(event) => setSolutionDraft(event.target.value)}
                      placeholder="Solution name"
                    />
                    <select
                      aria-label="Solution type"
                      value={solutionKind}
                      onChange={(event) => setSolutionKind(event.target.value as SolutionKind)}
                    >
                      {SOLUTION_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {SOLUTION_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="primary-button">
                      Add solution
                    </button>
                  </form>
                </div>

                {state.solutions.length === 0 ? (
                  <div className="empty-solutions">
                    <strong>No solution runs yet.</strong>
                    <span>
                      Add a solution for manual score entry, or import JSON predictions from a model
                      run.
                    </span>
                    <code>
                      {
                        '{ "name": "nsfwjs", "type": "nsfwjs", "predictions": { "case-id": { "nsfwjs": { "porn": 0.22, "hentai": 0.81, "sexy": 0.35, "drawings": 0.12 } } } }'
                      }
                    </code>
                  </div>
                ) : (
                  <>
                    <div className="metrics-wrap">
                      <table className="metrics-table">
                        <caption>
                          Aggregate performance over labeled cases · manual review counts entered
                          score cells
                        </caption>
                        <thead>
                          <tr>
                            <th>Solution</th>
                            <th colSpan={3}>Explicit</th>
                            <th colSpan={3}>AI-generated</th>
                            <th>Coverage</th>
                            <th colSpan={3}>Manual review</th>
                            <th aria-label="Actions" />
                          </tr>
                          <tr className="subhead">
                            <th aria-label="Solution details" />
                            <th>F1</th>
                            <th>Precision</th>
                            <th>Recall</th>
                            <th>F1</th>
                            <th>Precision</th>
                            <th>Recall</th>
                            <th>Scored / labeled</th>
                            <th>Right</th>
                            <th>Wrong</th>
                            <th>Pending</th>
                            <th aria-label="Actions" />
                          </tr>
                        </thead>
                        <tbody>
                          {state.solutions.map((solution) => {
                            const explicit = metricsFor(
                              state.cases,
                              solution,
                              'explicit',
                              state.thresholds.explicit,
                            );
                            const aiGenerated = metricsFor(
                              state.cases,
                              solution,
                              'aiGenerated',
                              state.thresholds.aiGenerated,
                            );
                            const review = manualReviewFor(state.cases, solution);
                            return (
                              <tr key={solution.id} data-testid={`metric-row-${solution.id}`}>
                                <th scope="row">
                                  <span className="solution-name">{solution.name}</span>
                                  <span className={`solution-kind ${solution.kind}`}>
                                    {SOLUTION_KIND_LABELS[solution.kind]}
                                  </span>
                                  {solution.description && <small>{solution.description}</small>}
                                </th>
                                <MetricCell value={explicit.f1} />
                                <MetricCell value={explicit.precision} />
                                <MetricCell value={explicit.recall} />
                                <MetricCell value={aiGenerated.f1} />
                                <MetricCell value={aiGenerated.precision} />
                                <MetricCell value={aiGenerated.recall} />
                                <td>
                                  {explicit.labeled + aiGenerated.labeled === 0
                                    ? '—'
                                    : `${explicit.scored + aiGenerated.scored} / ${explicit.labeled + aiGenerated.labeled}`}
                                </td>
                                <td>{review.right}</td>
                                <td>{review.wrong}</td>
                                <td>{review.pending}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="table-action"
                                    onClick={() => removeSolution(solution.id)}
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="predictions-wrap">
                      <div className="prediction-heading">
                        <div>
                          <p className="eyebrow">Selected case</p>
                          <h3>Predictions for this sample</h3>
                        </div>
                        <span>LLM scores plus raw NSFWJS class probabilities.</span>
                      </div>
                      <table className="predictions-table">
                        <thead>
                          <tr>
                            <th rowSpan={2}>Solution</th>
                            <th rowSpan={2}>Type</th>
                            <th colSpan={2}>LLM scores</th>
                            <th colSpan={4}>NSFWJS scores</th>
                          </tr>
                          <tr className="subhead">
                            {TASKS.map((task) => (
                              <th key={task}>{TASK_LABELS[task]}</th>
                            ))}
                            {NSFWJS_TASKS.map((task) => (
                              <th key={task}>{NSFWJS_LABELS[task]}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {state.solutions.map((solution) => (
                            <tr key={solution.id}>
                              <th scope="row">
                                <span className="solution-name">{solution.name}</span>
                              </th>
                              <td>
                                <span className={`solution-kind ${solution.kind}`}>
                                  {SOLUTION_KIND_LABELS[solution.kind]}
                                </span>
                              </td>
                              {TASKS.map((task) => renderPredictionCell(solution, task))}
                              {NSFWJS_TASKS.map((task) => renderPredictionCell(solution, task))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>
            </>
          ) : (
            <div className="empty-state">Add a sample to begin a benchmark.</div>
          )}
          {notice && <output className="notice">{notice}</output>}
        </section>
      </main>
    </div>
  );
}
