import { z } from "zod";

export const paymentProviderEventPayloadSchema = z.object({ eventRowId: z.string().uuid() });
