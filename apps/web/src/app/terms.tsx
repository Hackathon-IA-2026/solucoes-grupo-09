import { BulletList, LegalCard, LegalText } from "@wattsteer/ui";
import { type LegalContentSection, LegalScreen } from "@/components/legal-screen";

// Minimal, accurate terms for a public read-only site over public open data.
// The full versions are written alongside the landing page; what matters now
// is that nothing here describes a product WattSteer is not.
const UPDATED = "Last updated: August 28, 2026";

const SECTIONS: readonly LegalContentSection[] = [
  {
    id: "overview",
    title: "Overview",
    content: (
      <>
        <LegalText>
          These Terms of Service ("Terms") govern your use of WattSteer, a public,
          read-only site that analyses openly published Brazilian electricity system data
          to estimate renewable curtailment and the flexibility that could absorb it. By
          using WattSteer you agree to these Terms.
        </LegalText>
        <LegalCard tone="accent" title="Core principles">
          <BulletList
            onDark={true}
            items={[
              "Free to use — no account or signup required",
              "We work only with publicly published open data",
              "Forecasts and scenarios are estimates, not operational instructions",
              "Transparency about what the service does and does not do",
            ]}
          />
        </LegalCard>
      </>
    ),
  },
  {
    id: "service",
    title: "The service",
    content: (
      <>
        <LegalText>
          WattSteer publishes day-ahead estimates of renewable curtailment by subsystem,
          an explanation of the grid conditions associated with that estimate, and what-if
          scenarios showing how much of the estimated curtailment a given amount of
          storage or flexible demand could absorb.
        </LegalText>
        <LegalText>
          Source data is published by ONS (Operador Nacional do Sistema Elétrico), ANEEL
          and third-party weather providers. WattSteer is not affiliated with, endorsed
          by, or operated on behalf of any of them.
        </LegalText>
      </>
    ),
  },
  {
    id: "no-reliance",
    title: "No operational reliance",
    content: (
      <>
        <LegalText>
          Everything WattSteer publishes is a modelled estimate carrying uncertainty, and
          may be wrong. It is not a grid operating instruction, not a trading signal, and
          not investment, engineering or regulatory advice.
        </LegalText>
        <LegalText>
          Do not use WattSteer as an input to real-time system operation, dispatch or
          settlement. Decisions with physical or financial consequences remain yours, and
          should rest on the authoritative sources.
        </LegalText>
      </>
    ),
  },
  {
    id: "availability",
    title: "Availability and changes",
    content: (
      <LegalText>
        The service is provided as-is, without warranty of availability or accuracy.
        Upstream sources revise their published history, sometimes years after the fact,
        so figures shown here can change. We may modify or discontinue any part of the
        service at any time.
      </LegalText>
    ),
  },
  {
    id: "attribution",
    title: "Data attribution and licensing",
    content: (
      <LegalText>
        Source datasets remain the property of their publishers and are used under their
        respective open licences. Where a licence requires attribution or share-alike
        treatment of derived data, WattSteer complies with it; those notices appear
        alongside the data they cover.
      </LegalText>
    ),
  },
];

export default function Terms() {
  return (
    <LegalScreen
      headTitle="Terms of Service — WattSteer"
      path="/terms"
      badge="Terms of Service"
      updated={UPDATED}
      title="Terms of Service"
      intro="WattSteer is a public, read-only analysis of openly published grid data. These terms govern your use of it."
      sidebarTitle="Terms of Service"
      sections={SECTIONS}
    />
  );
}
