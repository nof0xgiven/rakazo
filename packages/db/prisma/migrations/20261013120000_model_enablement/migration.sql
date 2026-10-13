-- AlterTable
ALTER TABLE "user_model_credentials"
    ADD COLUMN "enabledModelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "modelConfigurationVersion" INTEGER NOT NULL DEFAULT 0;

-- Existing OpenAI-compatible connections keep exactly the models their owner
-- already selected in some space. Nothing else becomes authorized.
UPDATE "user_model_credentials" AS credential
SET "enabledModelIds" = seeded."modelIds"
FROM (
    SELECT "credentialId", ARRAY_AGG(DISTINCT "modelId" ORDER BY "modelId") AS "modelIds"
    FROM (
        SELECT
            preference."credentialId",
            REGEXP_REPLACE(preference."modelId", '^\s+|\s+$', '', 'g') AS "modelId"
        FROM "space_model_preferences" AS preference
        WHERE preference."modelId" IS NOT NULL
    ) AS trimmed
    WHERE "modelId" NOT IN ('', 'null', 'undefined')
    GROUP BY "credentialId"
) AS seeded
WHERE credential."id" = seeded."credentialId"
  AND credential."provider" = 'openai-compatible';
