ALTER TABLE "tasks" DROP CONSTRAINT "tasks_magic_link_protocol_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_magic_link_protocol_check" CHECK (
        coalesce(
          case
            when "tasks"."kind" = 'auth.magic_link_request' then
              "tasks"."queue_class" = 'auth_intake'
              and jsonb_typeof("tasks"."payload_json") = 'object'
              and not coalesce("tasks"."payload_json" ? 'deliveryProtocol', false)
              and not coalesce("tasks"."payload_json" ? 'email', false)
              and jsonb_typeof("tasks"."payload_json"->'version') = 'number'
              and "tasks"."payload_json"->>'version' = '1'
              and jsonb_typeof("tasks"."payload_json"->'requestId') = 'string'
              and ("tasks"."payload_json" - 'version' - 'requestId') = '{}'::jsonb
            when "tasks"."kind" = 'auth.magic_link_email'
              and coalesce("tasks"."payload_json" ? 'deliveryProtocol', false) then
              "tasks"."queue_class" = 'auth_delivery_v2'
              and jsonb_typeof("tasks"."payload_json") = 'object'
              and jsonb_typeof("tasks"."payload_json"->'version') = 'number'
              and "tasks"."payload_json"->>'version' = '1'
              and jsonb_typeof("tasks"."payload_json"->'deliveryProtocol') = 'number'
              and "tasks"."payload_json"->>'deliveryProtocol' = '2'
              and jsonb_typeof("tasks"."payload_json"->'tokenId') = 'string'
              and jsonb_typeof("tasks"."payload_json"->'encryptedToken') = 'string'
              and not coalesce("tasks"."payload_json" ? 'email', false)
              and (
                not coalesce("tasks"."payload_json" ? 'locale', false)
                or (
                  jsonb_typeof("tasks"."payload_json"->'locale') = 'string'
                  and "tasks"."payload_json"->>'locale' in ('zh', 'en', 'ja')
                )
              )
              and (
                "tasks"."payload_json" - 'version' - 'deliveryProtocol' - 'tokenId'
                - 'encryptedToken' - 'locale'
              ) = '{}'::jsonb
            when "tasks"."kind" = 'auth.magic_link_email' then
              "tasks"."queue_class" = 'transactional'
              and not coalesce("tasks"."payload_json" ? 'deliveryProtocol', false)
            else
              "tasks"."queue_class" not in ('auth_delivery_v2', 'auth_intake')
              and not coalesce("tasks"."payload_json" ? 'deliveryProtocol', false)
          end,
          false
        )
      );