import { env } from '@/lib/env';
import { timedFetch } from '@/lib/utils/timed-fetch';

// Form types that signal an actual or planned equity offering. We
// intentionally include both pricing forms (424B*) and registration forms
// (S-1, S-3, F-1, F-3, FWP) so an imminent offering still trips the flag
// even if pricing has not been filed yet.
//
// Reference: https://www.sec.gov/forms
const OFFERING_FORM_PREFIXES: readonly string[] = [
  '424B',
  '424A',
  '424H',
  'FWP',
  'S-1',
  'S-3',
  'F-1',
  'F-3'
];

export interface EdgarFiling {
  formType: string;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
}

export interface OfferingCheckResult {
  hasRecentFiling: boolean;
  formType: string | null;
  filingDate: string | null;
  totalRecentFilings: number;
  notes: string;
}

interface CompanyTickerEntry {
  cik_str?: number | string;
  ticker?: string;
}

interface SubmissionsRecentFilings {
  form?: string[];
  filingDate?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
}

interface SubmissionsResponse {
  filings?: { recent?: SubmissionsRecentFilings };
}

let cikMapPromise: Promise<Map<string, string>> | null = null;

function pad10(value: string | number): string {
  const s = String(value);
  return s.length >= 10 ? s : '0'.repeat(10 - s.length) + s;
}

async function loadCikMap(): Promise<Map<string, string>> {
  if (cikMapPromise) return cikMapPromise;
  cikMapPromise = (async () => {
    const res = await timedFetch(env.edgarTickersUrl, {
      headers: {
        accept: 'application/json',
        'user-agent': env.edgarUserAgent
      },
      timeoutMs: env.fetchTimeoutMs
    });
    if (!res.ok) {
      throw new Error(`EDGAR ticker map fetch failed ${res.status}`);
    }
    const json = (await res.json()) as Record<string, CompanyTickerEntry>;
    const map = new Map<string, string>();
    for (const entry of Object.values(json)) {
      if (entry.ticker && entry.cik_str != null) {
        map.set(entry.ticker.toUpperCase(), pad10(entry.cik_str));
      }
    }
    return map;
  })().catch((err) => {
    cikMapPromise = null;
    throw err;
  });
  return cikMapPromise;
}

// Test seam: clear the cached CIK map promise and let the next call refetch.
export function _resetEdgarCacheForTests(): void {
  cikMapPromise = null;
}

async function fetchSubmissions(cik: string): Promise<EdgarFiling[]> {
  const url = `${env.edgarBaseUrl}/submissions/CIK${cik}.json`;
  const res = await timedFetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': env.edgarUserAgent
    },
    timeoutMs: env.fetchTimeoutMs
  });
  if (!res.ok) {
    throw new Error(`EDGAR submissions fetch failed ${res.status}`);
  }
  const json = (await res.json()) as SubmissionsResponse;
  const recent = json.filings?.recent;
  if (!recent || !recent.form || !recent.filingDate) return [];
  const filings: EdgarFiling[] = [];
  const len = Math.min(recent.form.length, recent.filingDate.length);
  for (let i = 0; i < len; i += 1) {
    filings.push({
      formType: recent.form[i] ?? '',
      filingDate: recent.filingDate[i] ?? '',
      accessionNumber: recent.accessionNumber?.[i] ?? '',
      primaryDocument: recent.primaryDocument?.[i] ?? ''
    });
  }
  return filings;
}

function isOfferingForm(formType: string): boolean {
  const upper = formType.toUpperCase();
  return OFFERING_FORM_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// Inspects EDGAR submissions metadata for offering-related filings within the
// supplied window. No HTML parsing: we only look at form types and filing
// dates from the submissions JSON. If EDGAR is unreachable or the ticker
// cannot be mapped to a CIK, the result is treated as "no signal" with a
// descriptive note. Callers should NOT treat a thrown EDGAR error as an
// affirmative offering signal; this function never throws to the caller.
export async function checkRecentOfferingFiling(args: {
  ticker: string;
  fromDate: string;
  toDate: string;
}): Promise<OfferingCheckResult> {
  if (!env.edgarEnabled) {
    return { hasRecentFiling: false, formType: null, filingDate: null, totalRecentFilings: 0, notes: 'edgar_disabled' };
  }
  let cikMap: Map<string, string>;
  try {
    cikMap = await loadCikMap();
  } catch (err) {
    return {
      hasRecentFiling: false,
      formType: null,
      filingDate: null,
      totalRecentFilings: 0,
      notes: `edgar_cik_map_unavailable: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const cik = cikMap.get(args.ticker.toUpperCase());
  if (!cik) {
    return { hasRecentFiling: false, formType: null, filingDate: null, totalRecentFilings: 0, notes: 'edgar_no_cik_for_ticker' };
  }

  let filings: EdgarFiling[];
  try {
    filings = await fetchSubmissions(cik);
  } catch (err) {
    return {
      hasRecentFiling: false,
      formType: null,
      filingDate: null,
      totalRecentFilings: 0,
      notes: `edgar_submissions_unavailable: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const inWindow = filings.filter(
    (f) => f.filingDate && f.filingDate >= args.fromDate && f.filingDate <= args.toDate
  );
  const offering = inWindow.filter((f) => isOfferingForm(f.formType));

  if (offering.length === 0) {
    return {
      hasRecentFiling: false,
      formType: null,
      filingDate: null,
      totalRecentFilings: inWindow.length,
      notes: `edgar: ${inWindow.length} filings in window, no offering forms`
    };
  }

  const sorted = [...offering].sort((a, b) => b.filingDate.localeCompare(a.filingDate));
  const latest = sorted[0];
  return {
    hasRecentFiling: true,
    formType: latest.formType,
    filingDate: latest.filingDate,
    totalRecentFilings: inWindow.length,
    notes: `edgar: ${latest.formType} filed ${latest.filingDate}`
  };
}

// Exposed for tests: predicate for offering-form recognition.
export const _internal = { isOfferingForm, OFFERING_FORM_PREFIXES };
