import { Type, type TUnsafe } from "typebox";

/**
 * pi-ai 1.5.0 types its `StringEnum` as pi-schema's `Schema<T>`, which TypeBox cannot read,
 * so `Static` collapses the property to `unknown`. This returns a TypeBox `TUnsafe` instead
 * and matches the schema pi actually builds at runtime.
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
