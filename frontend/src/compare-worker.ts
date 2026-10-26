// Runs capture comparison off the Tools window's main thread: large SSE captures take seconds to parse and format.
import { bodyRecord, compareCaptures, comparisonText } from './capture-tools.mjs';

// A side is either a capture object or where to fetch it; fetching here keeps JSON parsing off the window too.
type Source = { fetchUrl: string; authorization: string } | Record<string, unknown>;
type Request = { id: number; left: Source; right: Source; options: Parameters<typeof compareCaptures>[2] };

async function load(source: Source) {
  if (typeof source.fetchUrl !== 'string') return source;
  const response = await fetch(source.fetchUrl, { headers: { Authorization: String(source.authorization) } });
  if (!response.ok) throw new Error(`Could not load the capture (${response.status})`);
  return response.json();
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, options } = event.data;
  try {
    let [left, right] = await Promise.all([load(event.data.left), load(event.data.right)]);
    // Custom JSON on either side compares bodies only; the chosen content selects which part of a capture that is.
    if (options.bodyOnly) [left, right] = [bodyRecord(left, options.section), bodyRecord(right, options.section)];
    const comparison = compareCaptures(left, right, options.bodyOnly ? { ...options, section: 'response' } : options);
    const texts = comparison.limited ? null : { original: comparisonText(left, options), modified: comparisonText(right, options) };
    self.postMessage({ id, comparison, texts });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
