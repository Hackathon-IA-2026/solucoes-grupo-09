# The demo script from `docs/plans/voice-copilot.md` §6, as executable prose.
#
# Six steps, in order, each driven by a recorded tool call. No audio, no socket,
# no renderer — the plan's §3.3 split is what makes that possible, and this file
# is the proof that the split bought something: the sequence a room will watch
# is checkable in a unit test.
#
# The steps are bound to the pure layer in `voice-execute.test.ts`; there is no
# Cucumber runtime in this repo and adding one would be a dependency for six
# scenarios. The parser there understands the subset used here and fails loudly
# on a step it does not recognise, so a scenario cannot pass by not running.

Feature: The demo script

  Background:
    Given the reader is looking at NE · wind · run 12Z on 2026-09-16

  # Step 1 — the step that proves the thesis. The assistant answers where the
  # reader already is instead of opening a screen at them.
  Scenario: 1 — which region should I worry about tomorrow
    When the model calls highlight with {"subsystem":"NE"}
    Then the intent kind is "highlight"
    And the highlighted subsystem is "NE"
    And no route change happens

  Scenario: 2 — why
    When the model calls explain with {"subsystem":"NE"}
    Then the intent kind is "navigate"
    And the route is "/app/explain"
    And the param "subsystem" is "NE"
    And the param "technology" is "wind"
    And the param "run" is "12Z"

  Scenario: 3 — what could I do about it
    When the model calls mitigate with {"subsystem":"NE"}
    Then the intent kind is "navigate"
    And the route is "/app/mitigate"
    And the param "subsystem" is "NE"
    And the link carries no scenario

  # Step 4 — the one to demo. The URL changes, the MILP re-solves on the server,
  # and the number that comes back is a real optimisation result.
  Scenario: 4 — what if I had a 500 MWh battery
    When the model calls mitigate with {"battery_mwh":500}
    Then the intent kind is "navigate"
    And the route is "/app/mitigate"
    And the link carries a scenario
    And the scenario battery energy is 500 MWh
    And the scenario battery power is unchanged

  Scenario: 5 — would that have worked last week
    When the model calls replay with {"relative_day":-7}
    Then the intent kind is "navigate"
    And the route is "/app/replay"
    And the param "episode" is "2026-08-11-ne"

  Scenario: 6 — take me back to the overview
    When the model calls show_grid with {}
    Then the intent kind is "navigate"
    And the route is "/app"
    And the param "subsystem" is "NE"
    And the param "technology" is "wind"
    And the param "run" is "12Z"
