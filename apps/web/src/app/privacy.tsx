import { BulletList, LegalCard, LegalText } from "@wattsteer/ui";
import { type LegalContentSection, LegalScreen } from "@/components/legal-screen";

// Minimal, accurate privacy policy for a public read-only site with no
// accounts and no personal data. The full version is written alongside the
// landing page; what matters now is that nothing here is false.
const UPDATED = "Last updated: August 28, 2026";

const SECTIONS: readonly LegalContentSection[] = [
  {
    id: "summary",
    title: "The short version",
    content: (
      <>
        <LegalText>
          WattSteer has no user accounts, no login, and no personal data to collect. It
          analyses openly published electricity system data — none of which describes
          individuals.
        </LegalText>
        <LegalCard tone="accent" title="What this means">
          <BulletList
            onDark={true}
            items={[
              "No signup, no account, no profile",
              "No advertising or cross-site tracking cookies",
              "No selling or sharing of data about you",
              "Nothing you type is stored against an identity",
            ]}
          />
        </LegalCard>
      </>
    ),
  },
  {
    id: "what-we-process",
    title: "What passes through WattSteer",
    content: (
      <>
        <LegalText>
          The data WattSteer works with is published openly by grid and regulatory bodies
          and describes power plants, load, generation and weather — not people.
        </LegalText>
        <LegalText>
          If you explore a what-if scenario, the parameters you enter are used to compute
          the result you asked for. They are not attached to an identity.
        </LegalText>
      </>
    ),
  },
  {
    id: "logs",
    title: "Server logs",
    content: (
      <LegalText>
        Like any web service, our infrastructure records ordinary request logs — IP
        address, timestamp, path, user agent — for security, abuse prevention and
        debugging. These are retained briefly and are not used to build a profile of you.
      </LegalText>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and storage",
    content: (
      <LegalText>
        WattSteer sets no advertising or cross-site tracking cookies. Any browser storage
        is limited to remembering your own display preferences on your own device, and
        never reaches our servers.
      </LegalText>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    content: (
      <LegalText>
        Questions about this policy can be sent to the address published on our
        repository.
      </LegalText>
    ),
  },
];

export default function Privacy() {
  return (
    <LegalScreen
      headTitle="Privacy Policy — WattSteer"
      path="/privacy"
      badge="Privacy Policy"
      updated={UPDATED}
      title="Privacy Policy"
      intro="WattSteer has no accounts and no personal data. This policy describes how little we handle."
      sidebarTitle="Privacy Policy"
      sections={SECTIONS}
    />
  );
}
