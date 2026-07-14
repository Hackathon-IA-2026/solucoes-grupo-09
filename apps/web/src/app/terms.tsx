import {
  BulletList,
  CardGrid,
  DataCard,
  LegalCard,
  LegalDivider,
  LegalText,
  SectionHeading,
} from "@zalytix/ui";
import { type LegalContentSection, LegalScreen } from "@/components/legal-screen";

const UPDATED = "Last updated: July 13, 2026";

const SECTIONS: ReadonlyArray<LegalContentSection> = [
  {
    id: "overview",
    title: "Overview",
    content: (
      <>
        <LegalText>
          These Terms of Service ("Terms") govern your use of Zalytix, a tool that scrapes
          publicly available App Store and Google Play reviews into clean, exportable
          data. By using Zalytix you agree to these Terms.
        </LegalText>
        <LegalCard tone="accent" title="Core principles">
          <BulletList
            onDark={true}
            items={[
              "Free to use — no account or signup required",
              "We work only with publicly available store data",
              "You are responsible for how you use exported data",
              "Transparency about what the service does and doesn't do",
            ]}
          />
        </LegalCard>
      </>
    ),
  },
  {
    id: "service",
    title: "The Service",
    content: (
      <>
        <SectionHeading
          title="What Zalytix does"
          subtitle="Paste an App Store or Google Play link and Zalytix returns:"
        />
        <CardGrid>
          <DataCard
            title="Review Scraping"
            description="Ratings, review text, developer replies, versions and reviewer names"
          />
          <DataCard
            title="Analytics"
            description="Sentiment, rating distribution, trends and an activity heatmap"
          />
          <DataCard
            title="Version & Metadata"
            description="App metadata and version history from the store page"
          />
          <DataCard
            title="Export"
            description="Download the results as CSV or JSON, generated in your browser"
          />
        </CardGrid>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable Use",
    content: (
      <>
        <SectionHeading
          title="Prohibited behavior"
          subtitle="When using Zalytix you agree not to:"
        />
        <BulletList
          items={[
            "Use the service for any unlawful purpose",
            "Overload, disrupt, or attempt to bypass rate limits or abuse controls",
            "Resell or rebrand the service as your own scraping API",
            "Use scraped data to harass, dox, or target individual reviewers",
            "Attempt to breach the security or integrity of the service",
          ]}
        />
        <LegalDivider />
        <LegalCard tone="warning" title="Respect the stores' terms">
          <LegalText>
            Zalytix accesses publicly visible store pages. You are responsible for
            ensuring your use complies with Apple's and Google's terms of service and with
            the laws that apply to you.
          </LegalText>
        </LegalCard>
      </>
    ),
  },
  {
    id: "data-and-scraping",
    title: "Data & Scraping",
    content: (
      <>
        <SectionHeading
          title="Public data only"
          subtitle="Zalytix collects only data that is publicly displayed on an app's store listing. It does not access private, authenticated, or personal account data."
        />
        <LegalCard tone="danger" title="Your responsibility">
          <LegalText>
            Exported reviews may contain personal data (such as reviewer names) that is
            already public on the store. You are the controller of any data you export and
            are responsible for handling it lawfully, including under GDPR, LGPD, or other
            regulations that apply to you.
          </LegalText>
        </LegalCard>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "Intellectual Property",
    content: (
      <>
        <SectionHeading
          title="Ownership"
          subtitle="Rights are split between Zalytix and third parties:"
        />
        <BulletList
          items={[
            "The Zalytix name, logo, interface, and source are owned by Zalytix",
            "Scraped review content belongs to its respective authors and the stores",
            "You receive a limited, revocable license to use the service",
            "No unauthorized reproduction of the Zalytix brand or interface",
          ]}
        />
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    content: (
      <>
        <SectionHeading
          title="Provided “as is”"
          subtitle="Zalytix is offered without warranties of any kind. We do not guarantee:"
        />
        <BulletList
          items={[
            "Uninterrupted or error-free availability",
            "That store data is complete, current, or accurate",
            "That a given app or storefront can always be scraped",
            "Any particular result, insight, or outcome",
          ]}
        />
      </>
    ),
  },
  {
    id: "limitation-liability",
    title: "Limitation of Liability",
    content: (
      <LegalText>
        To the fullest extent permitted by law, Zalytix is not liable for any indirect,
        incidental, or consequential damages arising from your use of the service, or for
        how you use data you export. The service is provided free of charge and on a
        best-effort basis.
      </LegalText>
    ),
  },
  {
    id: "changes",
    title: "Changes to These Terms",
    content: (
      <>
        <SectionHeading
          title="Updates"
          subtitle="We may update these Terms from time to time:"
        />
        <BulletList
          items={[
            "Material changes will be reflected on this page",
            "Continued use after an update indicates acceptance",
            "The “last updated” date above always reflects the current version",
          ]}
        />
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    content: (
      <LegalText>Questions about these Terms? Reach us at support@zalytix.com.</LegalText>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalScreen
      headTitle="Terms of Service — Zalytix"
      path="/terms"
      badge="Terms of Service"
      updated={UPDATED}
      title="Terms of Service"
      intro="Welcome to Zalytix. These terms govern your use of our App Store and Google Play review scraper."
      sidebarTitle="Terms of Service"
      sections={SECTIONS}
    />
  );
}
