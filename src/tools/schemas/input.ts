import { Type } from "typebox";

export const name = Type.String({ minLength: 1, maxLength: 128 });
export const params = Type.Record(Type.String(), Type.Unknown());
