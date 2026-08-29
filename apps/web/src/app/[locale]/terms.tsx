import { BulletList, LegalCard, LegalText } from "@wattsteer/ui";
import { type LegalContentSection, LegalScreen } from "@/components/legal-screen";
import { useCopy } from "@/i18n";

/** Terms of service, at `/pt/terms` and `/en/terms`. Prose lives in the copy
 * dictionaries — see the note in `privacy.tsx` for why. */
export default function Terms() {
  const copy = useCopy();
  const t = copy.legal.terms;

  const sections: readonly LegalContentSection[] = [
    {
      id: "overview",
      title: t.overview.title,
      content: (
        <>
          <LegalText>{t.overview.body}</LegalText>
          <LegalCard tone="accent" title={t.overview.cardTitle}>
            <BulletList onDark={true} items={[...t.overview.cardItems]} />
          </LegalCard>
        </>
      ),
    },
    {
      id: "service",
      title: t.service.title,
      content: (
        <>
          <LegalText>{t.service.body}</LegalText>
          <LegalText>{t.service.sources}</LegalText>
        </>
      ),
    },
    {
      id: "no-reliance",
      title: t.reliance.title,
      content: (
        <>
          <LegalText>{t.reliance.body}</LegalText>
          <LegalText>{t.reliance.yours}</LegalText>
        </>
      ),
    },
    {
      id: "availability",
      title: t.availability.title,
      content: <LegalText>{t.availability.body}</LegalText>,
    },
    {
      id: "attribution",
      title: t.attribution.title,
      content: <LegalText>{t.attribution.body}</LegalText>,
    },
  ];

  return (
    <LegalScreen
      headTitle={copy.meta.terms.title}
      description={copy.meta.terms.description}
      path="/terms"
      badge={t.badge}
      updated={t.updated}
      title={t.title}
      intro={t.intro}
      sidebarTitle={t.title}
      sections={sections}
    />
  );
}
