import { BulletList, LegalCard, LegalText } from "@wattsteer/ui";
import { type LegalContentSection, LegalScreen } from "@/components/legal-screen";
import { useCopy } from "@/i18n";

/**
 * Privacy policy, at `/pt/privacy` and `/en/privacy`.
 *
 * The prose lives in the copy dictionaries rather than inline in this file.
 * That is not tidiness: a page served under `/pt/` with `lang="pt-BR"` and
 * English body text is a worse lie than the client-side switch this route
 * tree replaced, because the URL and the `lang` attribute both assert a
 * language the reader is not being given.
 */
export default function Privacy() {
  const copy = useCopy();
  const t = copy.legal.privacy;

  const sections: readonly LegalContentSection[] = [
    {
      id: "summary",
      title: t.summary.title,
      content: (
        <>
          <LegalText>{t.summary.body}</LegalText>
          <LegalCard tone="accent" title={t.summary.cardTitle}>
            <BulletList onDark={true} items={[...t.summary.cardItems]} />
          </LegalCard>
        </>
      ),
    },
    {
      id: "what-we-process",
      title: t.processing.title,
      content: (
        <>
          <LegalText>{t.processing.body}</LegalText>
          <LegalText>{t.processing.scenarios}</LegalText>
        </>
      ),
    },
    { id: "logs", title: t.logs.title, content: <LegalText>{t.logs.body}</LegalText> },
    {
      id: "cookies",
      title: t.cookies.title,
      content: <LegalText>{t.cookies.body}</LegalText>,
    },
    {
      id: "contact",
      title: t.contact.title,
      content: <LegalText>{t.contact.body}</LegalText>,
    },
  ];

  return (
    <LegalScreen
      headTitle={copy.meta.privacy.title}
      description={copy.meta.privacy.description}
      path="/privacy"
      badge={t.badge}
      updated={t.updated}
      title={t.title}
      intro={t.intro}
      sidebarTitle={t.title}
      sections={sections}
    />
  );
}
