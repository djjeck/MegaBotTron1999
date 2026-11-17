/**
 * Finding the exports under an input folder, the part that needs no file system: given every entry
 * under it, which are HTML pages and in which order, which are JSON exports, and which warnings to
 * print (zip files); given a page, which text files it links to as attachments. Pure functions, no
 * Node or browser APIs; the adapters list the entries (files.ts on disk, browser-files.ts for the
 * files a browser folder picker gives) and read the pages and their text files.
 *
 * The order of the pages, of the JSON exports and of the warnings is that of a depth-first walk
 * with the entries of every folder sorted by name (comparePaths): a folder before its subfolders,
 * siblings by name. It decides the output, so it is the same on every OS, file system and browser.
 */
import { MEDIA_FILE, PAGE, pageKey } from './html.ts';
import { feedHtml } from './html-events.ts';
import { type Page } from './messages.ts';
import { comparePaths, normalizePath, pathName, pathParent } from './paths.ts';

/** One entry (file, folder or anything else) under an input folder. */
export interface ExportEntry {
  /** Normalised path, starting with the input folder as given (`inbox/x/messages.html`). */
  path: string;
  /** Whether it is a file (or a link to one); asked only of the entries named `*.zip`. */
  isFile(): boolean;
}

/** What an input folder holds, as the readers read it. */
export interface ExportListing {
  /** The paths of the HTML export pages, in (folder, page number) order. */
  pages: string[];
  /**
   * The JSON exports (`result.json`) of the folders without HTML pages, in folder order: a folder
   * exported in both formats is read from its HTML, as the wiki generator's reader (#60) reads it.
   */
  json: string[];
  /** Warnings for the user: the zip files, in order. */
  warnings: string[];
}

const PAGE_NAME = /^messages[^/]*\.html$/; // glob "messages*.html"
const ZIP_NAME = /^[^/]*\.zip$/; // glob "*.zip"
const RESULT_JSON = 'result.json';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A text file's content: strict UTF-8, BOM kept, `\r\n` and `\r` turned into `\n`. */
export function decodeText(bytes: Uint8Array): string {
  return utf8.decode(bytes).replace(/\r\n?/g, '\n');
}

/** The warning for a zip file, which is never opened. */
export function zipWarning(file: string): string {
  return `skipping ${file}: zip files are not read, extract the export into a folder`;
}

/** The warning for an input path that is neither a folder, a JSON export nor a zip file. */
export function notAFolderWarning(p: string): string {
  return `skipping ${p}: not a folder, a .json file or a .zip file`;
}

/**
 * The pages, JSON exports and warnings of one input folder, from all its entries (in any order). A
 * folder with a `result.json` and no `messages*.html` entry is a JSON export; every `*.zip` file
 * is skipped with a warning; the pages are the `messages*.html` entries whose name is a page name
 * (PAGE), in folder order, then page number.
 */
export function listExport(entries: readonly ExportEntry[]): ExportListing {
  const withPageName = new Set<string>();
  for (const e of entries)
    if (PAGE_NAME.test(pathName(e.path))) withPageName.add(pathParent(e.path));
  const warnings: string[] = [];
  const json = entries
    .filter((e) => pathName(e.path) === RESULT_JSON && !withPageName.has(pathParent(e.path)))
    .map((e) => e.path)
    .sort(comparePaths);
  const zips = entries
    .filter((e) => ZIP_NAME.test(pathName(e.path)))
    .sort((a, b) => comparePaths(a.path, b.path));
  for (const z of zips) if (z.isFile()) warnings.push(zipWarning(z.path));
  const pages = entries
    .map((e) => e.path)
    .filter((p) => PAGE_NAME.test(pathName(p)) && PAGE.test(p))
    .map((p) => ({ p, parent: pathParent(p), page: pageKey(p) }))
    .sort((a, b) => comparePaths(a.parent, b.parent) || a.page - b.page)
    .map(({ p }) => p);
  return { pages, json, warnings };
}

/** A link to a text file attached to a message, as Telegram writes it: `files/file (1).txt`. */
export const TEXT_FILE_LINK = /^files\/[^/]+\.txt$/iu;

/**
 * The text files a page links to as attachments (`a.media_file` whose `href` is
 * `files/<name>.txt`), in page order and once each: the link as written, and the path of
 * the file beside the page (`<page folder>/files/<name>.txt`). An adapter reads those
 * that the export holds into Page.files.
 */
export function linkedTextFiles(label: string, html: string): { link: string; path: string }[] {
  if (!html.includes('media_file')) return [];
  const links = new Set<string>();
  feedHtml(html, {
    starttag(tag, attrs) {
      const href = attrs.get('href');
      if (tag === 'a' && MEDIA_FILE.test(attrs.get('class') ?? '') && href)
        if (TEXT_FILE_LINK.test(href)) links.add(href);
    },
    startendtag() {},
    endtag() {},
    data() {},
  });
  const folder = pathParent(label);
  return [...links].map((link) => ({ link, path: normalizePath(`${folder}/${link}`) }));
}

/**
 * A page with the linked text files that `read` gives (null for one the export does not
 * hold). A file that is not UTF-8 is left out, like one the export does not hold.
 */
export function withTextFiles(page: Page, read: (path: string) => Uint8Array | null): Page {
  const files = new Map<string, string>();
  for (const { link, path } of linkedTextFiles(page.label, page.html)) {
    const bytes = read(path);
    if (bytes === null) continue;
    try {
      files.set(link, decodeText(bytes));
    } catch {
      // Not UTF-8: not a file the readers read.
    }
  }
  return files.size === 0 ? page : { ...page, files };
}
