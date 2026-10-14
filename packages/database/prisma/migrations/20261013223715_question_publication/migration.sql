-- CreateEnum
CREATE TYPE "publication_state" AS ENUM ('PUBLISHED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "publication_action" AS ENUM ('PUBLISH', 'WITHDRAW');

-- CreateEnum
CREATE TYPE "bank_health" AS ENUM ('NEW', 'HEALTHY', 'WATCH', 'DEGRADED');

-- CreateTable
CREATE TABLE "question_publication" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "state" "publication_state" NOT NULL,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMP(3),
    "withdraw_reason_code" VARCHAR(40),
    "withdraw_note" VARCHAR(1000),

    CONSTRAINT "question_publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_publication_event" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "action" "publication_action" NOT NULL,
    "actor_kind" VARCHAR(8) NOT NULL,
    "actor_account_id" UUID,
    "reason_code" VARCHAR(40),
    "note" VARCHAR(1000),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_publication_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_bank_state" (
    "question_id" UUID NOT NULL,
    "health" "bank_health" NOT NULL,
    "changed_by" UUID,
    "reason_code" VARCHAR(40),
    "note" VARCHAR(1000),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "question_bank_state_pkey" PRIMARY KEY ("question_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "question_publication_revision_id_key" ON "question_publication"("revision_id");

-- CreateIndex
CREATE INDEX "question_publication_state_idx" ON "question_publication"("state");

-- CreateIndex
CREATE INDEX "question_publication_event_revision_id_idx" ON "question_publication_event"("revision_id");

-- AddForeignKey
ALTER TABLE "question_publication" ADD CONSTRAINT "question_publication_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "question_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_bank_state" ADD CONSTRAINT "question_bank_state_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
