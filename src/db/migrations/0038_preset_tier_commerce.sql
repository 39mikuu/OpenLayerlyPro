WITH "preset"("slug", "price_label", "price_amount_minor", "currency", "description") AS (
	VALUES
		('supporter', '¥9 / 月', 900::bigint, 'cny', '支持创作者持续更新，并获得支持者身份与基础会员内容。'),
		('hd-member', '¥29 / 月', 2900::bigint, 'cny', '查看高清原图与高分辨率会员内容。'),
		('pack-member', '¥59 / 月', 5900::bigint, 'cny', '解锁高清内容，并下载创作素材包与配套资源。')
)
UPDATE "membership_tiers" AS "tier"
SET
	"price_amount_minor" = CASE
		WHEN "tier"."price_amount_minor" IS NULL
			AND NULLIF(BTRIM("tier"."currency"), '') IS NULL
			THEN "preset"."price_amount_minor"
		ELSE "tier"."price_amount_minor"
	END,
	"currency" = CASE
		WHEN "tier"."price_amount_minor" IS NULL
			AND NULLIF(BTRIM("tier"."currency"), '') IS NULL
			THEN "preset"."currency"
		ELSE "tier"."currency"
	END,
	"description" = CASE
		WHEN NULLIF(BTRIM("tier"."description"), '') IS NULL THEN "preset"."description"
		ELSE "tier"."description"
	END,
	"updated_at" = NOW()
FROM "preset"
WHERE
	"tier"."slug" = "preset"."slug"
	AND "tier"."price_label" = "preset"."price_label"
	AND (
		(
			"tier"."price_amount_minor" IS NULL
			AND NULLIF(BTRIM("tier"."currency"), '') IS NULL
		)
		OR NULLIF(BTRIM("tier"."description"), '') IS NULL
	);
