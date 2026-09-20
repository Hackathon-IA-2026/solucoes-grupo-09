-- An opinion about one answer the product gave. Never a measurement: see
-- `answerFeedback` in `src/database/schema.ts` for why it reaches no view.

CREATE TABLE "answer_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"surface" text NOT NULL,
	"verdict" text NOT NULL,
	"subject" jsonb NOT NULL,
	"reason" text,
	"locale" text NOT NULL,
	CONSTRAINT "answer_feedback_surface" CHECK ("answer_feedback"."surface" in ('forecast', 'replay', 'evidence')),
	CONSTRAINT "answer_feedback_verdict" CHECK ("answer_feedback"."verdict" in ('up', 'down')),
	CONSTRAINT "answer_feedback_locale" CHECK ("answer_feedback"."locale" in ('pt', 'en'))
);
--> statement-breakpoint
CREATE INDEX "answer_feedback_recorded_at" ON "answer_feedback" USING btree ("recorded_at");