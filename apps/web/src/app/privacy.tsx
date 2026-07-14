import {
  BulletList,
  CardGrid,
  DataCard,
  IconCard,
  LegalCard,
  LegalDivider,
  LegalTable,
  LegalText,
  RightCard,
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
          This Privacy Policy explains how Zalytix handles information when you use our
          App Store and Google Play review scraper. Zalytix has no user accounts and is
          built to keep data handling minimal and transient.
        </LegalText>
        <LegalCard tone="accent" title="Privacy principles">
          <BulletList
            onDark={true}
            items={[
              "No accounts — we don't ask you to sign up or log in",
              "Minimal collection — only what a scrape needs to run",
              "Transient by design — results aren't tied to a personal profile",
              "No selling or renting of data, ever",
            ]}
          />
        </LegalCard>
      </>
    ),
  },
  {
    id: "data-we-handle",
    title: "Information We Handle",
    content: (
      <>
        <SectionHeading
          title="What passes through Zalytix"
          subtitle="To run a scrape and return results, we handle:"
        />
        <CardGrid>
          <DataCard
            title="The store link you submit"
            description="Used to identify which app and storefront to scrape"
          />
          <DataCard
            title="Public review data"
            description="Fetched from the store and returned to you; processed transiently"
          />
          <DataCard
            title="No tracking"
            description="No analytics or advertising cookies — we don't build a profile of you"
          />
          <DataCard
            title="No personal account"
            description="We don't collect names, emails, or passwords — there is no login"
          />
        </CardGrid>
        <LegalDivider />
        <SectionHeading
          title="Automatically received"
          subtitle="Like any web service, our hosting layer briefly processes:"
        />
        <BulletList
          items={[
            "IP address and user agent (for rate limiting and abuse prevention)",
            "Request timing and error logs (operational, short-lived)",
          ]}
        />
      </>
    ),
  },
  {
    id: "how-we-use",
    title: "How We Use Information",
    content: (
      <>
        <SectionHeading
          title="Purposes"
          subtitle="We use the information above only to:"
        />
        <BulletList
          items={[
            "Run the scrape you requested and return the results",
            "Protect the service with rate limiting and abuse prevention",
            "Diagnose errors and keep the service reliable (short-lived logs)",
          ]}
        />
      </>
    ),
  },
  {
    id: "data-sharing",
    title: "Data Sharing",
    content: (
      <>
        <SectionHeading
          title="We don't sell your data"
          subtitle="We never sell, rent, or trade information. We rely on a small set of infrastructure providers to run the service:"
        />
        <LegalTable
          headers={["Provider", "Purpose", "Data"]}
          rows={[
            ["Railway", "API hosting & scraping compute", "Requests, IP (transient)"],
            ["Cloudflare", "Frontend hosting, CDN & DNS", "Standard request logs"],
          ]}
        />
        <LegalCard tone="warning" title="Legal requirements">
          <LegalText>
            We may disclose information if required by law, or to protect the rights,
            property, or safety of Zalytix and its users.
          </LegalText>
        </LegalCard>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies & Tracking",
    content: (
      <>
        <SectionHeading
          title="No tracking cookies"
          subtitle="Zalytix is a static, stateless site with no login — it sets no advertising or cross-site tracking cookies and does not build a profile of you."
        />
        <LegalTable
          headers={["Cookie", "Set by", "Purpose"]}
          rows={[
            [
              "Essential security",
              "Cloudflare (CDN / hosting)",
              "Protect and serve the site",
            ],
          ]}
        />
      </>
    ),
  },
  {
    id: "data-security",
    title: "Data Security",
    content: (
      <>
        <SectionHeading
          title="How we protect requests"
          subtitle="We apply appropriate technical measures:"
        />
        <CardGrid>
          <IconCard
            icon="🔒"
            title="HTTPS everywhere"
            description="All traffic is encrypted in transit"
          />
          <IconCard
            icon="🚫"
            title="No credential storage"
            description="There are no accounts or passwords to leak"
          />
          <IconCard
            icon="🛡️"
            title="Rate limiting"
            description="Abuse controls guard the scraping surface"
          />
        </CardGrid>
      </>
    ),
  },
  {
    id: "data-retention",
    title: "Data Retention",
    content: (
      <>
        <SectionHeading
          title="Transient by design"
          subtitle="We keep as little as possible, for as short as possible:"
        />
        <BulletList
          items={[
            "Scrape results are returned to you and not tied to a personal profile",
            "Job records are held in memory and auto-evicted (capped, short-lived)",
            "Exports (CSV/JSON) are generated in your browser — we don't store them",
            "Operational logs are short-lived and used only for reliability",
          ]}
        />
      </>
    ),
  },
  {
    id: "your-rights",
    title: "Your Rights",
    content: (
      <>
        <SectionHeading
          title="Rights over your information"
          subtitle="Because we don't hold personal accounts, most requests are simple:"
        />
        <RightCard
          title="Access"
          description="Ask what, if anything, we hold that relates to you"
        />
        <RightCard
          title="Deletion"
          description="Request deletion — note that results aren't stored after your session"
        />
        <RightCard
          title="Objection"
          description="Object to processing, including operational logging"
        />
      </>
    ),
  },
  {
    id: "children-privacy",
    title: "Children's Privacy",
    content: (
      <LegalText>
        Zalytix is a developer/marketing tool and is not directed to children under 13. We
        do not knowingly collect personal information from children.
      </LegalText>
    ),
  },
  {
    id: "changes",
    title: "Changes to This Policy",
    content: (
      <>
        <SectionHeading
          title="Updates"
          subtitle="We may update this policy for operational, legal, or regulatory reasons. Changes are posted on this page and reflected in the “last updated” date above."
        />
        <LegalText>Questions? Reach us at support@zalytix.com.</LegalText>
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalScreen
      headTitle="Privacy Policy — Zalytix"
      path="/privacy"
      badge="Privacy Policy"
      updated={UPDATED}
      title="Privacy Policy"
      intro="Thanks for using Zalytix. This policy describes how we handle information — and how little of it we keep."
      sidebarTitle="Privacy Policy"
      sections={SECTIONS}
    />
  );
}
