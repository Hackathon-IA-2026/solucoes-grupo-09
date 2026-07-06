CREATE TABLE "reviews" (
	"store" text NOT NULL,
	"id" text NOT NULL,
	"app_id" text NOT NULL,
	"country" text NOT NULL,
	"user_name" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"rating" integer NOT NULL,
	"date" text DEFAULT '' NOT NULL,
	"developer_response" jsonb,
	"thumbs_up" integer,
	"app_version" text,
	"is_edited" boolean,
	"scraped_at" text NOT NULL,
	CONSTRAINT "reviews_store_id_pk" PRIMARY KEY("store","id")
);
--> statement-breakpoint
CREATE TABLE "scrape_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"store" text NOT NULL,
	"app_id" text NOT NULL,
	"country" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reviews_app_idx" ON "reviews" USING btree ("store","app_id","country");