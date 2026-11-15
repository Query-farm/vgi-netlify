/**
 * Assemble the `netlify` catalog: the `main` tables and table functions, the
 * `unified.runs` table, and the `netlify` secret type.
 */

import { type CatalogDescriptor, field, schema, type TableDescriptor, utf8, type VgiFunction } from "@query-farm/vgi";
import {
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  SCHEMA_DOC_MD,
  SCHEMA_TAGS,
  SOURCE_URL,
  UNIFIED_DOC_MD,
  UNIFIED_SCHEMA_TAGS,
} from "./meta.ts";
import { SECRET_TYPE } from "./netlify/client.ts";
import { FUNCTIONS, MAIN_TABLES, UNIFIED_TABLES } from "./netlify/resources.ts";

export { FUNCTIONS };

/** CREATE SECRET (TYPE netlify, TOKEN '…' [, BASE_URL '…']). */
export const NETLIFY_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Netlify personal access token or OAuth token, plus an optional API base URL",
  schema: schema(
    [
      field(
        "token",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          [
            "vgi_doc",
            "Netlify personal access token (User settings > Applications > Personal access tokens) or OAuth access token; sent as a bearer token.",
          ],
        ]),
      ),
      field(
        "base_url",
        utf8(),
        true,
        new Map([
          [
            "vgi_doc",
            "API base URL; default https://api.netlify.com/api/v1 (http:// is accepted only for 127.0.0.1/localhost).",
          ],
        ]),
      ),
    ],
    new Map([["vgi_doc_url", "https://docs.netlify.com/api/get-started/#authentication"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const tableExamples = (tables: TableDescriptor[]): Example[] =>
  tables.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);

const MAIN_EXAMPLES = [...tableExamples(MAIN_TABLES), ...stampExampleQueries(FUNCTIONS)];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [NETLIFY_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tables: MAIN_TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(MAIN_EXAMPLES.slice(0, 12)) },
    },
    {
      path: ["unified"],
      comment: UNIFIED_DOC_MD,
      functions: [],
      tables: UNIFIED_TABLES,
      tags: { ...UNIFIED_SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(tableExamples(UNIFIED_TABLES)) },
    },
  ],
};
