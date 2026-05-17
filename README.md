# Finnish Law MCP Server

<!-- ANSVAR-CTA-BEGIN -->
> ### ▶ Try this MCP instantly via Ansvar Gateway
> **50 free queries/day · no card required · OAuth signup at [ansvar.eu/gateway](https://ansvar.eu/gateway)**
>
> One endpoint, one OAuth signup, access from any MCP-compatible client.

### Connect

**Claude Code** (one line):

```bash
claude mcp add ansvar --transport http https://gateway.ansvar.eu/mcp
```

**Claude Desktop / Cursor** — add to `claude_desktop_config.json` (or `mcp.json`):

```json
{
  "mcpServers": {
    "ansvar": {
      "type": "url",
      "url": "https://gateway.ansvar.eu/mcp"
    }
  }
}
```

**Claude.ai** — Settings → Connectors → Add custom connector → paste `https://gateway.ansvar.eu/mcp`

First request opens an OAuth flow at [ansvar.eu/gateway](https://ansvar.eu/gateway). After signup, your client is bound to your account; tier (free / premium / team / company) determines fan-out, quota, and which downstream MCPs are reachable.

---

## Self-host this MCP

You can also clone this repo and build the corpus yourself. The schema,
fetcher, and tool implementations all live here. What is not in the repo is
the pre-built database — TDM and standards-licensing constraints on the
upstream sources mean we host the corpus on Ansvar infrastructure rather
than redistribute it as a public artifact.

Build your own: run this repo's ingestion script (entry-point varies per
repo — typically `scripts/ingest.sh`, `npm run ingest`, or `make ingest`;
check the repo root).
<!-- ANSVAR-CTA-END -->


**The Finlex alternative for the AI age.**

[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/Ansvar-Systems/finnish-law-mcp?style=social)](https://github.com/Ansvar-Systems/finnish-law-mcp)
[![CI](https://github.com/Ansvar-Systems/finnish-law-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Ansvar-Systems/finnish-law-mcp/actions/workflows/ci.yml)
[![Daily Data Check](https://github.com/Ansvar-Systems/finnish-law-mcp/actions/workflows/check-updates.yml/badge.svg)](https://github.com/Ansvar-Systems/finnish-law-mcp/actions/workflows/check-updates.yml)
[![Database](https://img.shields.io/badge/database-pre--built-green)](docs/EU_INTEGRATION_GUIDE.md)
[![Provisions](https://img.shields.io/badge/provisions-31%2C198-blue)](docs/EU_INTEGRATION_GUIDE.md)

Query **Finnish statutes** -- from Tietosuojalaki and Rikoslaki to Osakeyhtiölaki, Ympäristönsuojelulaki, and more -- directly from Claude, Cursor, or any MCP-compatible client.

If you're building legal tech, compliance tools, or doing Finnish legal research, this is your verified reference database.

Built by [Ansvar Systems](https://ansvar.eu) -- Helsinki, Finland

---

## Why This Exists

Swedish legal research is scattered across Riksdagen, SFS publications, lagen.nu, and EUR-Lex. Whether you're:
- A **lawyer** validating citations in a brief or contract
- A **compliance officer** checking if a statute is still in force
- A **legal tech developer** building tools on Swedish law
- A **researcher** tracing legislative history from proposition to statute

...you shouldn't need 47 browser tabs and manual PDF cross-referencing. Ask Claude. Get the exact provision. With context.

This MCP server makes Swedish law **searchable, cross-referenceable, and AI-readable**.

---

## Example Queries

Once connected, just ask naturally:

- *"What does Dataskyddslagen 3 kap. 5 § say about consent?"*
- *"Is PUL (1998:204) still in force?"*
- *"Find provisions about personuppgifter in Swedish law"*
- *"What EU directives does DSL implement?"*
- *"Which Swedish laws implement the GDPR?"*
- *"Get the preparatory works for Dataskyddslagen"*
- *"Compare incident reporting requirements across NIS2 Swedish implementations"*
- *"Validate the citation NJA 2020 s. 45"*
- *"Find Labour Court cases about discrimination from 2020-2023"*

---

## What's Included

| Category | Count | Details |
|----------|-------|---------|
| **Statutes** | 717 laws | Comprehensive Swedish legislation |
| **Provisions** | 31,198 sections | Full-text searchable with FTS5 |
| **Preparatory Works** | 3,625 documents | Propositions (Prop.) and SOUs |
| **EU Cross-References** | 668 references | 228 EU directives and regulations |
| **Legal Definitions** | 615 terms | Extracted from statute text |
| **Database Size** | ~70 MB | Optimized SQLite, portable |
| **Daily Updates** | Automated | Freshness checks against Riksdagen |

**Verified data only** -- every citation is validated against official sources (Riksdagen, lagen.nu, EUR-Lex). Zero LLM-generated content.

---

## See It In Action

### Why This Works

**Verbatim Source Text (No LLM Processing):**
- All statute text is ingested from Riksdagen/SFS official sources
- Provisions are returned **unchanged** from SQLite FTS5 database rows
- Zero LLM summarization or paraphrasing -- the database contains regulation text, not AI interpretations

**Smart Context Management:**
- Search returns ranked provisions with BM25 scoring (safe for context)
- Provision retrieval gives exact text by SFS number + chapter/section
- Cross-references help navigate without loading everything at once

**Technical Architecture:**
```
Riksdagen API → Parse → SQLite → FTS5 snippet() → MCP response
                  ↑                      ↑
           Provision parser       Verbatim database query
```

### Traditional Research vs. This MCP

| Traditional Approach | This MCP Server |
|---------------------|-----------------|
| Search Riksdagen by SFS number | Search by plain Swedish: *"personuppgifter samtycke"* |
| Navigate multi-chapter statutes manually | Get the exact provision with context |
| Manual cross-referencing between laws | `build_legal_stance` aggregates across sources |
| "Is this statute still in force?" → check manually | `check_currency` tool → answer in seconds |
| Find EU basis → dig through EUR-Lex | `get_eu_basis` → linked EU directives instantly |
| Check 5+ sites for updates | Daily automated freshness checks |
| No API, no integration | MCP protocol → AI-native |

**Traditional:** Search Riksdagen → Download SFS PDF → Ctrl+F → Cross-reference with proposition → Check EUR-Lex for EU basis → Repeat

**This MCP:** *"What EU law is the basis for DSL 3 kap. 5 § about consent?"* → Done.

---

## Available Tools (13)

### Core Legal Research Tools (8)

| Tool | Description |
|------|-------------|
| `search_legislation` | FTS5 search on 31,198 provisions with BM25 ranking |
| `get_provision` | Retrieve specific provision by SFS + chapter/section |
| `search_case_law` | FTS5 search on case law with court/date filters |
| `get_preparatory_works` | Get linked propositions and SOUs for a statute |
| `validate_citation` | Validate citation against database (zero-hallucination check) |
| `build_legal_stance` | Aggregate citations from statutes, case law, prep works |
| `format_citation` | Format citations per Swedish conventions (full/short/pinpoint) |
| `check_currency` | Check if statute is in force, amended, or repealed |

### EU Law Integration Tools (5)

| Tool | Description |
|------|-------------|
| `get_eu_basis` | Get EU directives/regulations for Swedish statute |
| `get_swedish_implementations` | Find Swedish laws implementing EU act |
| `search_eu_implementations` | Search EU documents with Swedish implementation counts |
| `get_provision_eu_basis` | Get EU law references for specific provision |
| `validate_eu_compliance` | Check implementation status (future, requires EU MCP) |

---

## EU Law Integration

**668 cross-references** linking 49 Swedish statutes to EU law, with bi-directional lookup.

| Metric | Value |
|--------|-------|
| **EU References** | 668 cross-references |
| **EU Documents** | 228 unique directives and regulations |
| **Swedish Statutes with EU Refs** | 49 (68% of database) |
| **Directives** | 89 |
| **Regulations** | 139 |
| **EUR-Lex Integration** | Automated metadata fetching |

### Most Referenced EU Acts

1. **eIDAS Regulation** (910/2014) - 20 references
2. **E-Signatures Directive** (1999/93) - 15 references
3. **GDPR** (2016/679) - 15 references
4. **Data Protection Directive** (1995/46) - 14 references
5. **Market Surveillance Regulation** (2019/1020) - 14 references

See [EU_INTEGRATION_GUIDE.md](docs/EU_INTEGRATION_GUIDE.md) for detailed documentation and [EU_USAGE_EXAMPLES.md](docs/EU_USAGE_EXAMPLES.md) for practical examples.

---

## Data Sources & Freshness

All content is sourced from authoritative Swedish legal databases:

- **[Riksdagen](https://riksdagen.se/)** -- Swedish Parliament's official legal database
- **[Svensk Forfattningssamling](https://svenskforfattningssamling.se/)** -- Official statute collection
- **[Lagen.nu](https://lagen.nu)** -- Case law database (CC-BY Domstolsverket)
- **[EUR-Lex](https://eur-lex.europa.eu/)** -- Official EU law database (metadata only)

### Automated Freshness Checks (Daily)

A [daily GitHub Actions workflow](.github/workflows/check-updates.yml) monitors all data sources:

| Source | Check | Method |
|--------|-------|--------|
| **Statute amendments** | Riksdagen API date comparison | All 717 statutes checked |
| **New statutes** | Riksdagen SFS publications (90-day window) | Diffed against database |
| **Case law** | lagen.nu feed entry count | Compared to database |
| **Preparatory works** | Riksdagen proposition API (30-day window) | New props detected |
| **EU reference staleness** | Git commit timestamps | Flagged if >90 days old |

The workflow supports `auto_update: true` dispatch for automated sync, rebuild, version bump, and npm publishing.

---

## Security

This project uses multiple layers of automated security scanning:

| Scanner | What It Does | Schedule |
|---------|-------------|----------|
| **CodeQL** | Static analysis for security vulnerabilities | Weekly + PRs |
| **Semgrep** | SAST scanning (OWASP top 10, secrets, TypeScript) | Every push |
| **Gitleaks** | Secret detection across git history | Every push |
| **Trivy** | CVE scanning on filesystem and npm dependencies | Daily |
| **Docker Security** | Container image scanning + SBOM generation | Daily |
| **Socket.dev** | Supply chain attack detection | PRs |
| **OSSF Scorecard** | OpenSSF best practices scoring | Weekly |
| **Dependabot** | Automated dependency updates | Weekly |

See [SECURITY.md](SECURITY.md) for the full policy and vulnerability reporting.

---

## Important Disclaimers

### Legal Advice

> **THIS TOOL IS NOT LEGAL ADVICE**
>
> Statute text is sourced from official Riksdagen/SFS publications. However:
> - This is a **research tool**, not a substitute for professional legal counsel
> - **Court case coverage is limited** -- do not rely solely on this for case law research
> - **Verify critical citations** against primary sources for court filings
> - **EU cross-references** are extracted from Swedish statute text, not EUR-Lex full text

**Before using professionally, read:** [DISCLAIMER.md](DISCLAIMER.md) | [PRIVACY.md](PRIVACY.md)

### Client Confidentiality

Queries go through the Claude API. For privileged or confidential matters, use on-premise deployment. See [PRIVACY.md](PRIVACY.md) for Advokatsamfundet compliance guidance.

---

## Documentation

- **[EU Integration Guide](docs/EU_INTEGRATION_GUIDE.md)** -- Detailed EU cross-reference documentation
- **[EU Usage Examples](docs/EU_USAGE_EXAMPLES.md)** -- Practical EU lookup examples
- **[Security Policy](SECURITY.md)** -- Vulnerability reporting and scanning details
- **[Disclaimer](DISCLAIMER.md)** -- Legal disclaimers and professional use notices
- **[Privacy](PRIVACY.md)** -- Client confidentiality and data handling

---

## Development

### Setup

```bash
git clone https://github.com/Ansvar-Systems/swedish-law-mcp
cd swedish-law-mcp
npm install
npm run build
npm test
```

### Running Locally

```bash
npm run dev                                       # Start MCP server
npx @anthropic/mcp-inspector node dist/index.js   # Test with MCP Inspector
```

### Data Management

```bash
npm run ingest -- <sfs-number> <output.json>   # Ingest statute from Riksdagen
npm run ingest:cases:full-archive              # Ingest case law (full archive)
npm run sync:cases                             # Ingest case law (incremental)
npm run sync:prep-works                        # Sync preparatory works
npm run extract:definitions                    # Extract legal definitions
npm run build:db                               # Rebuild SQLite database
npm run check-updates                          # Check for amendments
```

### Performance

- **Search Speed:** <100ms for most FTS5 queries
- **Database Size:** ~70 MB (efficient, portable)
- **Reliability:** 100% ingestion success rate

---

## More Ansvar MCPs

Full fleet at [ansvar.eu/gateway](https://ansvar.eu/gateway).
## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Priority areas:
- Court case law expansion (currently limited coverage)
- EU Regulations MCP integration (full EU law text, CJEU case law)
- Historical statute versions and amendment tracking
- Lower court decisions (Tingsrätt, Hovrätt)

---

## Roadmap

- [x] **Statute expansion** -- 785% growth from 81 to 717 statutes (v1.1.0)
- [x] **EU law integration** -- 668 cross-references to 228 EU directives/regulations (v1.1.0)
- [ ] Court case law expansion (scraper updated, re-ingestion needed for 12K-18K cases)
- [ ] Lower court coverage (Tingsrätt, Hovrätt archives)
- [ ] Historical statute versions (amendment tracking)
- [ ] English translations for key statutes
- [ ] Web API for programmatic access

---

## Citation

If you use this MCP server in academic research:

```bibtex
@software{swedish_law_mcp_2025,
  author = {Ansvar Systems AB},
  title = {Swedish Law MCP Server: Production-Grade Legal Research Tool},
  year = {2025},
  url = {https://github.com/Ansvar-Systems/swedish-law-mcp},
  note = {Comprehensive Swedish legal database with 717 statutes and EU law cross-references}
}
```

---

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.

### Data Licenses

- **Statutes & Propositions:** Swedish Government (public domain)
- **Case Law:** CC-BY Domstolsverket (via lagen.nu)
- **EU Metadata:** EUR-Lex (EU public domain)

---

## About Ansvar Systems

We build AI-accelerated compliance and legal research tools for the European market. This MCP server started as our internal reference tool for Swedish law -- turns out everyone building for the Swedish market has the same research frustrations.

So we're open-sourcing it. Navigating 717 statutes shouldn't require a law degree.

**[ansvar.eu](https://ansvar.eu)** -- Stockholm, Sweden

---

<p align="center">
  <sub>Built with care in Stockholm, Sweden</sub>
</p>
