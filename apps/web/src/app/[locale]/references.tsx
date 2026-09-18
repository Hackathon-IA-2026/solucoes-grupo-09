import {
  BulletList,
  LegalCard,
  LegalTable,
  LegalText,
  space,
  usePalette,
} from "@wattsteer/ui";
import { Link } from "expo-router";
import { Platform, View } from "react-native";
import { type LegalContentSection, LegalScreen } from "@/components/legal-screen";
import { useCopy } from "@/i18n";
import {
  GRID_PROCEDURES_URL,
  LEI_15269_URL,
  NT_DOP_0022_URL,
  OPEN_METEO_LICENCE_URL,
  REN_1030_URL,
} from "@/lib/regulatory";

/**
 * Norms, licences and glossary, at `/pt/references` and `/en/references`.
 *
 * The same shell as the terms and privacy pages, because it is the same kind of
 * document: prose a reader consults once, kept in the copy dictionaries. It
 * answers the specialist review's AC-01/02/04/05/08/11/13 in one place, and the
 * `RegulatoryNote` at the foot of every page and every app screen links here.
 */
export default function References() {
  const copy = useCopy();
  const colors = usePalette();
  const r = copy.legal.references;

  // The norm names are the documents' own, so they label their links in both
  // locales; the table above already says what each one sets out.
  const officialTexts: readonly (readonly [string, string])[] = [
    [REN_1030_URL, "REN ANEEL 1.030/2022"],
    [NT_DOP_0022_URL, "NT-ONS DOP 0022/2025"],
    [LEI_15269_URL, "Lei 15.269/2025"],
    [GRID_PROCEDURES_URL, "Procedimentos de Rede (ONS)"],
    [OPEN_METEO_LICENCE_URL, "Open-Meteo"],
  ];

  const sections: readonly LegalContentSection[] = [
    {
      id: "norms",
      title: r.norms.title,
      content: (
        <>
          <LegalText>{r.norms.body}</LegalText>
          {/* One card per norm rather than a three-column table: at 390 px the
              table broke words mid-syllable, and a norm is read one at a time. */}
          {r.norms.rows.map(([norm, setsOut, where]) => (
            <LegalCard key={norm} title={norm}>
              <LegalText>{setsOut}</LegalText>
              <LegalText>{`${r.norms.whereLabel}: ${where}`}</LegalText>
            </LegalCard>
          ))}
          <LegalText>{r.norms.linksTitle}</LegalText>
          <View style={{ gap: space.sm }}>
            {officialTexts.map(([href, label]) => (
              <Link
                key={href}
                href={href as never}
                target="_blank"
                style={{
                  fontSize: 15,
                  lineHeight: 22,
                  color: colors.accent,
                  // Not colour alone: the underline says "link" on every platform.
                  textDecorationLine: "underline",
                  ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                }}
              >
                {label}
              </Link>
            ))}
          </View>
        </>
      ),
    },
    {
      id: "traceability",
      title: r.traceability.title,
      content: <LegalText>{r.traceability.body}</LegalText>,
    },
    {
      id: "licences",
      title: r.licences.title,
      content: <BulletList items={[...r.licences.items]} />,
    },
    {
      id: "glossary",
      title: r.glossary.title,
      content: (
        <>
          <LegalText>{r.glossary.body}</LegalText>
          <LegalTable headers={r.glossary.headers} rows={r.glossary.rows} />
        </>
      ),
    },
  ];

  return (
    <LegalScreen
      headTitle={copy.meta.references.title}
      description={copy.meta.references.description}
      path="/references"
      badge={r.badge}
      updated={r.updated}
      title={r.title}
      intro={r.intro}
      sidebarTitle={r.title}
      sections={sections}
    />
  );
}
