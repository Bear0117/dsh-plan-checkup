// Assemble the M2 report page: report.src.html holds the prose with
// <!--table:id--> markers, and results/tables.html (from tables.mjs) the tables.
// Usage: node eval/report.mjs && node eval/tables.mjs && node eval/build-report.mjs [out]
import { readFileSync, writeFileSync } from 'node:fs'

const out = process.argv[2] ?? '../dsh-plan-checkup-m2-report.html'
const source = readFileSync('eval/report.src.html', 'utf8')
const tables = readFileSync('eval/results/tables.html', 'utf8')
const byId = new Map([...tables.matchAll(/<section data-table="([a-z-]+)">([\s\S]*?)<\/section>/g)]
  .map(([, id, body]) => [id, `<div data-table="${id}">${body}</div>`]))

const page = source.replace(/<!--table:([a-z-]+)-->/g, (marker, id) => {
  if (!byId.has(id)) throw new Error(`no table "${id}" in results/tables.html`)
  return byId.get(id)
})
writeFileSync(out, page)
console.log(`${out}: ${page.length} bytes`)
