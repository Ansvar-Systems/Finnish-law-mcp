# Coverage Limitations

This document details what legal sources are **NOT** included in this Tool and the impact on legal research completeness.

---

## Executive Summary

⚠️ **This Tool is Incomplete** — Critical legal sources are missing.

**Major Gaps:**
1. 🇪🇺 **EU Regulations and Directives** — Finnish law increasingly implements EU law
2. ⚖️ **CJEU Case Law** — Court of Justice of the European Union (binding on Finnish courts)
3. 📜 **Historical Statute Versions** — Limited availability of provision wording over time
4. 📚 **Legal Commentary** — No annotations, academic commentary, or practice guides
5. 🏛️ **Lower Court Decisions** — Käräjäoikeus and Hovioikeus largely missing
6. 📋 **Preparatory Works** — Limited coverage of hallituksen esitykset (HE) and committee reports

**Impact**: Professional legal research using this Tool **will miss critical authorities** and must be supplemented with additional sources.

---

## 1. EU Law (Critical Gap)

### What's Missing

#### EU Regulations

**Examples:**
- **GDPR** (Regulation (EU) 2016/679) — Data protection
- **Digital Services Act** (Regulation (EU) 2022/2065) — Online platform liability
- **Markets in Crypto-Assets** (MiCA) (Regulation (EU) 2023/1114) — Cryptocurrency regulation
- **AI Act** (Regulation (EU) 2024/1689) — Artificial intelligence regulation

**Status in This Tool**: ❌ **Not Included**

**Why It Matters:**
- EU Regulations are **directly applicable** in Finland (no transposition required)
- Supremacy clause — EU law overrides conflicting Finnish law
- Finnish courts must apply EU Regulations alongside Finnish statutes

#### EU Directives

**Examples:**
- **Whistleblower Protection Directive** (Directive (EU) 2019/1937)
- **Copyright in the Digital Single Market** (Directive (EU) 2019/790)
- **Shareholder Rights Directive II** (Directive (EU) 2017/828)

**Status in This Tool**: ❌ **Not Included**

**Why It Matters:**
- Finland transposes Directives into national law (often visible in Finnish statutes)
- Need EU Directive text to understand legislative intent and interpretation
- CJEU interprets Directives — binding on Finnish courts

#### CJEU Case Law

**Court**: Court of Justice of the European Union (Luxembourg)

**Examples:**
- *Google Spain* (C-131/12) — Right to be forgotten (GDPR)
- *Schrems II* (C-311/18) — International data transfers
- *Viking Line* (C-438/05) — Freedom of establishment vs. labor rights (Finnish company)
- *Åklagaren v. Hans Åkerberg Fransson* (C-617/10) — Ne bis in idem principle

**Status in This Tool**: ❌ **Not Included**

**Why It Matters:**
- CJEU decisions are **binding** on Finnish courts
- Supremacy and direct effect — CJEU interpretation prevails over national law
- Finnish law must be interpreted consistently with CJEU precedent

---

### Impact on Finnish Law Interpretation

**Problem**: Finnish law is increasingly **enmeshed with EU law**. Researching Finnish GDPR implementation (Tietosuojalaki 1050/2018) without access to:
- EU GDPR text
- CJEU data protection case law
- European Data Protection Board (EDPB) guidelines

...results in **incomplete and potentially incorrect legal analysis**.

**Example Scenario:**

A lawyer searches this Tool for "data breach notification requirements" and finds:

```
Tietosuojalaki (1050/2018) 3 luku 5 §
"Rekisterinpitäjän on ilmoitettava henkilötietojen tietoturvaloukkauksesta
valvontaviranomaiselle..."
```

**What's Missing:**
- GDPR Article 33 (source of Finnish provision)
- CJEU cases interpreting "without undue delay"
- EDPB guidelines on notification scope
- Article 29 Working Party opinions

Without these sources, the lawyer may:
- Miss CJEU case law limiting the Finnish provision's scope
- Incorrectly apply Finnish law where GDPR directly applies
- Fail to advise on cross-border notification obligations under GDPR

---

### Workaround

**Use Companion MCP Server:**

```json
{
  "mcpServers": {
    "finnish-law": {
      "command": "npx",
      "args": ["-y", "@ansvar/finnish-law-mcp"]
    },
    "eu-regulations": {
      "command": "npx",
      "args": ["-y", "@ansvar/eu-regulations-mcp"]
    }
  }
}
```

**[@ansvar/eu-regulations-mcp](https://github.com/Ansvar-Systems/EU_compliance_MCP)**: Companion server covering:
- EU Regulations and Directives
- CJEU case law (via EUR-Lex)
- EDPB guidelines and opinions
- European Commission guidance

**Combined Coverage**: Finnish law + EU law = more complete legal research

---

## 2. Historical Statute Versions (Significant Gap)

### What's Missing

**Historical Provision Wording**: Provisions as they existed on specific dates in the past.

**Example:**
- **Current (2026)**: Tietosuojalaki (1050/2018) has been amended multiple times
- **Historical (2020)**: What did Chapter 3, Section 5 say on 2020-06-15?

**Status in This Tool**:
- ⚠️ **Limited**: Some historical versions in `legal_provision_versions` table
- ❌ **Incomplete**: Not all amendments tracked
- ❌ **No Systematic Coverage**: Depends on manual ingestion of amendments

---

### Why Historical Versions Matter

#### Transitional Law Issues

**Scenario**: Contract signed in 2019 references Tietosuojalaki. Dispute arises in 2026.

**Question**: Which version of Tietosuojalaki applies — 2019 or 2026?

**Answer Depends On**:
- Transitional provisions in the amending statute (siirtymäsäännös)
- Lex posterior vs. lex specialis rules
- Contract interpretation principles (law at time of signing)

**This Tool Cannot Reliably Answer** without comprehensive historical version tracking.

---

#### Legal History Research

**Use Cases:**
- Academic research on legislative evolution
- Constitutional law challenges (was provision valid when enacted?)
- Human rights litigation (compliance with ECHR at time of events)

**Current Limitation**: Tool focuses on **current law**, not legal history.

---

### Workaround

**For Professional Use**:
- **Edilex**: Comprehensive historical versions with annotations
- **Finlex**: Query by publication date for original statute text
- **Manual Research**: Statute archive at universities and law libraries

**For This Tool (Future Enhancement)**:
- Ingest all amendments systematically from Finlex
- Build provision version graph (valid_from, valid_to)
- Support `as_of_date` queries across all statutes

---

## 3. Legal Commentary and Annotations (Critical for Professional Use)

### What's Missing

**Doctrinal Commentary**:
- Academic articles and treatises
- Practitioner guides and handbooks
- Editorial annotations explaining application

**Practice Notes**:
- Precedent analysis ("this provision has been applied in X contexts")
- Drafting tips ("when citing this provision, note Y exception")
- Cross-references to related provisions and preparatory works

**Status in This Tool**: ❌ **Not Included** — Plain statutory text and case summaries only

---

### Why Commentary Matters

**Statutory Text is Ambiguous**: Finnish law, like all law, requires interpretation.

**Example**: Tietosuojalaki (1050/2018), 3 luku 5 §

> "Rekisterinpitäjän on ilmoitettava henkilötietojen tietoturvaloukkauksesta valvontaviranomaiselle **ilman aiheetonta viivytystä**..."

**Question**: What is "ilman aiheetonta viivytystä" (without undue delay)?

**Answers Require Commentary**:
- Tietosuojavaltuutettu (TSV) guidance: 72 hours in practice
- CJEU case law on "without undue delay" under GDPR Article 33
- Academic debate on Finnish vs. GDPR standard
- Practitioner experience from enforcement actions

**This Tool Provides**: Raw statute text
**Professional Research Requires**: Commentary explaining the 72-hour rule and TSV practice

---

### Workaround

**Commercial Databases**:
- **Edilex**: Extensive annotations by legal experts
- **Alma Talent**: Practice notes and commentary
- **WSOYpro/Juridica**: Academic literature integration

**Academic Resources**:
- **Lakimies**: Leading Finnish law journal
- **Defensor Legis (DL)**: Academic commentary
- University library databases (JSTOR, HeinOnline)

---

## 4. Lower Court Decisions (Major Gap in Case Law)

### What's Missing

**Courts NOT Comprehensively Covered**:
- **Käräjäoikeudet** (District Courts) — Trial-level decisions
- **Hovioikeudet** (Courts of Appeal) — Appellate decisions
- **Hallinto-oikeudet** (Administrative Courts) — First-instance admin law
- **Markkinaoikeus** (Market Court) — Competition and IP decisions

**Status in This Tool**:
- ✅ **Good Coverage**: Supreme courts (KKO, KHO)
- ⚠️ **Partial Coverage**: Some appellate court decisions (via opendata.finlex.fi)
- ❌ **Poor Coverage**: District and administrative courts

---

### Why Lower Courts Matter

#### Precedential Value

While Finnish law is not strictly bound by stare decisis, lower court decisions:
- Indicate judicial trends and reasoning patterns
- Fill gaps where KKO/KHO has not ruled
- Provide practical examples of statutory application
- Show how trial courts interpret ambiguous provisions

---

#### Volume of Law Practice

**Statistical Reality**:
- **99% of cases** are decided by lower courts (never reach KKO/KHO)
- **Practitioners need** to know how Käräjäoikeus judges interpret statutes
- **Supreme Court cases** are rare and may not address common issues

**This Tool's Bias**: Skewed toward Supreme Court decisions, missing the **bulk of judicial practice**.

---

### Workaround

**Official Sources**:
- **Finlex**: Selected lower court decisions published by the Ministry of Justice
- **Edilex**: Commercial database with broader lower court coverage

**Practical Research**:
- Contact clerks at relevant Käräjäoikeus/Hovioikeus
- Freedom of Information requests (julkisuuslaki) for specific cases

---

## 5. Preparatory Works (Significant Gap)

### What's Missing

**Lainvalmisteluasiakirjat (Preparatory Works)**:
- **Hallituksen esitykset (HE)** — Government Bills with detailed legislative intent
- **Valiokunnan mietinnöt** — Parliamentary committee reports (e.g., LaVM, PeVM, VaVM)
- **Lausunnot** — Expert opinions submitted during legislative process

**Status in This Tool**:
- ⚠️ **Limited**: Some preparatory works linked in `preparatory_works` table
- ❌ **Not Comprehensive**: Only manually ingested works included
- ❌ **No Full Text**: Summaries only, not full HE text

---

### Why Preparatory Works Matter

**Finnish Legal Method**: Statutory interpretation heavily relies on lainvalmisteluaineisto (preparatory works).

**Hierarchy of Interpretation**:
1. Statutory text (sanamuoto)
2. **Lainvalmisteluaineisto** — Legislative history and intent (HE, committee reports)
3. Systematic interpretation (systematiikka)
4. Teleological interpretation (tarkoitus)

**Preparatory works are authoritative** for understanding ambiguous provisions.

**Example**: Tietosuojalaki (1050/2018)

**Question**: Does "rekisterinpitäjä" include small non-profits?

**Answer Found In**: HE 9/2018 vp, s. 152 (Government Bill)
> "Myös pienet yhdistykset kuuluvat rekisterinpitäjän käsitteen alaan, jos ne käsittelevät henkilötietoja..."

**This Tool**: ❌ Does not include HE 9/2018 vp full text

---

### Workaround

**Official Source**:
- **Finlex**: Full-text HE documents freely available
- **Eduskunta.fi**: Parliamentary records including committee reports and expert opinions

**Commercial Databases**:
- **Edilex/Alma Talent**: Indexed and searchable preparatory works with cross-references

**This Tool (Future Enhancement)**:
- Ingest full-text HE documents via Finlex API
- Link provisions to specific paragraphs in preparatory works
- Full-text search across lainvalmisteluaineisto

---

## 6. Decrees and Administrative Regulations (Asetukset)

### What's Missing

**Subordinate Legislation**:
- **Valtioneuvoston asetukset** — Government decrees implementing statutes
- **Ministeriöiden asetukset** — Ministerial decrees
- **Viranomaismääräykset** — Agency regulations (e.g., TSV guidelines)
- **EU Implementing Acts** — Commission regulations

**Status in This Tool**: ❌ **Not Included**

---

### Why Asetukset Matter

**Statutory Delegation**: Statutes often delegate details to asetukset.

**Example**: Tietosuojalaki (1050/2018), 7 luku 1 §

> "Valtioneuvosto voi antaa **asetuksen** tarkemmista säännöksistä..."

**Implementation**: Tietosuoja-asetus — Government decree with penalty and procedure details

**This Tool Has**: Tietosuojalaki (statute)
**This Tool Missing**: Implementing decrees with operational details

**Result**: Incomplete picture of data protection law without asetukset.

---

### Workaround

**Official Sources**:
- **Finlex**: Includes both laki (statutes) and asetus (decrees) in full text
- **Agency websites**: Tietosuojavaltuutettu, Finanssivalvonta publish their own määräykset

**This Tool (Future Enhancement)**:
- Ingest asetukset alongside statutes
- Link statutes to implementing decrees
- Include key agency guidelines

---

## 7. International Treaties and Conventions

### What's Missing

**Treaties Finland Has Ratified**:
- **ECHR** (European Convention on Human Rights, SopS 19/1990)
- **ICCPR** (International Covenant on Civil and Political Rights)
- **Geneva Conventions** (International humanitarian law)
- **Bilateral investment treaties** (BITs)

**Status in This Tool**: ❌ **Not Included**

---

### Why Treaties Matter

**Constitutional Incorporation**: Finland is **dualist** — treaties must be incorporated into Finnish law.

**But**: ECtHR (European Court of Human Rights) case law heavily influences Finnish courts.

**Example**: ECHR Article 8 (right to privacy)
- Incorporated via SopS 19/1990
- ECtHR case law cited regularly by KKO and KHO
- Influences interpretation of Finnish privacy and data protection laws

**This Tool**: ❌ Does not include treaty texts or ECtHR case law

---

### Workaround

**Official Sources**:
- **ECHR**: https://www.echr.coe.int/
- **HUDOC**: ECtHR case law database
- **UN Treaty Collection**: International human rights treaties
- **Finlex**: Incorporated treaties published in Suomen säädöskokoelman sopimussarja (SopS)

**Commercial Databases**:
- **Edilex/Alma Talent**: Include ECHR and other key treaties

---

## 8. Legal Definitions and Terminology

### What's Missing

**Legal Dictionary**:
- Finnish-Swedish-English legal terms
- Definitions of oikeustermit (legal terms of art)
- Cross-references between concepts

**Status in This Tool**: ⚠️ **Limited** — Some definitions in `definitions` table, but not comprehensive

---

### Why Definitions Matter

**Example**: "Edunvalvoja" vs. "Edunvalvontavaltuutettu"

**Question**: What's the difference?

**This Tool**: May find statutes mentioning both, but no definitional guidance

**Professional Databases**: Include legal dictionaries explaining the distinction:
- **Edunvalvoja**: Court-appointed guardian under holhoustoimilaki
- **Edunvalvontavaltuutettu**: Person appointed by the individual themselves in advance via edunvalvontavaltuutus

---

### Workaround

**Resources**:
- **IATE (EU terminology database)**: Finnish-Swedish-English legal terms
- **Edilex**: Built-in Finnish legal glossary
- **Norstedts Juridik / Alma Talent**: Finnish-Swedish legal dictionaries

**This Tool (Future Enhancement)**:
- Expand `definitions` table systematically
- Link definitions to provisions where terms are used
- Finnish-Swedish-English terminology mapping

---

## Coverage Summary Matrix

| Legal Source | Coverage | Impact on Professional Use | Workaround |
|--------------|----------|---------------------------|------------|
| **Finnish Statutes (lait)** | ✅ Good | Low | N/A |
| **Finnish Case Law (KKO/KHO)** | ✅ Good | Low | Verify with Finlex |
| **Finnish Case Law (Lower Courts)** | ⚠️ Partial | Medium | Edilex, Domstol.fi |
| **EU Regulations** | ❌ Missing | **High** | @ansvar/eu-regulations-mcp |
| **EU Directives** | ❌ Missing | **High** | @ansvar/eu-regulations-mcp |
| **CJEU Case Law** | ❌ Missing | **High** | EUR-Lex, Edilex |
| **Historical Statute Versions** | ⚠️ Limited | Medium | Edilex, Finlex archive |
| **Legal Commentary** | ❌ Missing | **High** | Edilex, Lakimies journal |
| **Preparatory Works / HE (Full Text)** | ⚠️ Partial | Medium-High | Finlex, Eduskunta.fi |
| **Asetukset (Decrees)** | ❌ Missing | Medium | Finlex |
| **International Treaties (SopS)** | ❌ Missing | Medium | ECHR, HUDOC, Finlex |
| **Legal Definitions** | ⚠️ Limited | Low-Medium | IATE, Edilex |

---

## Recommended Multi-Source Research Strategy

### For Professional Legal Work

**1. Initial Research** (This Tool)
- Quick statutory lookups
- Case law keyword search
- Preliminary hypothesis generation

**2. EU Law Layer** (@ansvar/eu-regulations-mcp)
- Identify applicable EU Regulations/Directives
- Check CJEU case law on interpretation
- Review EDPB/Commission guidance

**3. Official Verification** (Finlex, Eduskunta.fi)
- Verify statute currency and amendments
- Check official case law citations
- Access full-text HE preparatory works

**4. Professional Database** (Edilex, Alma Talent)
- Read editorial commentary and annotations
- Review practice notes and precedent analysis
- Check cross-references and related sources
- Confirm no recent developments missed

**5. Academic Research** (If Needed)
- Lakimies, Defensor Legis (DL) articles
- Doctoral dissertations and treatises
- Comparative Nordic law sources

---

## Future Roadmap: Expanding Coverage

### Planned Enhancements

**Near-Term (Next 6 Months)**:
- [ ] Full-text preparatory works (HE, valiokunnan mietinnöt)
- [ ] Asetukset (government decrees)
- [ ] Expanded definitions table
- [ ] Historical statute version tracking

**Medium-Term (6-12 Months)**:
- [ ] Integration with @ansvar/eu-regulations-mcp (EU law layer)
- [ ] ECHR and ECtHR case law
- [ ] Lower court decision ingestion (via Finlex and Edilex)
- [ ] Legal commentary integration (if licensed sources available)

**Long-Term (12+ Months)**:
- [ ] Nordic law integration (Sweden, Norway, Denmark)
- [ ] Comparative law sources
- [ ] AI-powered cross-referencing and relationship mapping

---

## How to Request Coverage Expansion

**Want a specific legal source added?**

1. **Open GitHub Issue**: https://github.com/Ansvar-Systems/Finnish-law-mcp/issues
2. **Label**: `coverage-enhancement`
3. **Include**:
   - Source name and URL
   - License status (open data, API terms, copyright)
   - Use case (why this source matters for legal research)
   - Estimated impact (how many users would benefit)

**Community Contributions Welcome**: If you have expertise in a specific legal area and want to contribute data or parsers, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Summary: What This Tool Is NOT

❌ **NOT a complete legal research platform**
❌ **NOT a substitute for Edilex/Alma Talent/commercial databases**
❌ **NOT comprehensive without EU law integration**
❌ **NOT authoritative for professional legal work without verification**
❌ **NOT a replacement for reading preparatory works and commentary**

**This Tool Is**:
✅ A **starting point** for legal research
✅ A **supplement** to professional databases
✅ A **rapid lookup** tool for known citations
✅ An **open-source alternative** for preliminary research

**Golden Rule**: Use this Tool as **one source among many**, not the sole basis for legal conclusions.

---

**Last Updated**: 2026-04-09
**Tool Version**: Current
