# The Visual Briefing, as executable prose. `VISUAL_PLAN.md` §3.
#
# What these scenarios pin is the *contract between the model and the product*,
# which is the half a screenshot cannot check: the model says that a briefing is
# owed and what about, and it never says what is in one. Every scenario below
# ends without a route change, because a briefing overlays the screen the reader
# is on — the same rule `highlight` follows, and for the same reason.
#
# Bound to the pure layer in `voice-execute.test.ts`, like the demo script
# beside it. No audio, no socket, no renderer.

Feature: Ask WattSteer

  Background:
    Given the reader is looking at NE · wind · run 12Z on 2026-09-16

  # The question whose answer is a sequence rather than a sentence.
  Scenario: why is the Northeast at risk tomorrow
    When the model calls brief with {"question_kind":"why"}
    Then the intent kind is "brief"
    And the briefed question kind is "why"
    And the briefed subsystem is "NE"
    And no route change happens

  # A briefing inherits the selection rather than demanding one, which is the
  # courtesy `focus` already extends: "why?" while looking at NE means NE.
  Scenario: the subsystem is optional and falls back to the selection
    When the model calls brief with {"question_kind":"tomorrow"}
    Then the intent kind is "brief"
    And the briefed subsystem is "NE"

  # And it can be pointed elsewhere without moving the reader.
  Scenario: a briefing about another region does not navigate to it
    When the model calls brief with {"question_kind":"what_happened","subsystem":"S"}
    Then the intent kind is "brief"
    And the briefed subsystem is "S"
    And no route change happens

  # A kind the composer does not branch on is refused rather than guessed at.
  # The model is told to answer by speaking instead.
  Scenario: an unknown question kind is refused, not approximated
    When the model calls brief with {"question_kind":"vibes"}
    Then the intent kind is "refused"
    And the refusal code is "unknown_question_kind"
