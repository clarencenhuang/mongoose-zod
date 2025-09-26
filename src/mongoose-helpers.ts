import M from 'mongoose';
import {z} from 'zod';
import {MongooseZodError} from './errors.js';
import {MongooseSchemaOptionsSymbol, type ZodMongoose} from './extensions.js';

const getInternalDef = (schema: z.ZodTypeAny) =>
  ((schema as unknown as { _zod?: { def?: Record<PropertyKey, unknown> }; _def?: Record<PropertyKey, unknown> })._zod?.def ??
    (schema as unknown as { _def?: Record<PropertyKey, unknown> })._def ??
    ({} as Record<PropertyKey, unknown>));

type StringLiteral<T> = T extends string ? (string extends T ? never : T) : never;

export const genTimestampsSchema = <CrAt = 'createdAt', UpAt = 'updatedAt'>(
  createdAtField: StringLiteral<CrAt | 'createdAt'> | null = 'createdAt',
  updatedAtField: StringLiteral<UpAt | 'updatedAt'> | null = 'updatedAt',
) => {
  if (createdAtField != null && updatedAtField != null && createdAtField === updatedAtField) {
    throw new MongooseZodError('`createdAt` and `updatedAt` fields must be different');
  }

  const schema = z.object({
    // Do not explicitly create `createdAt` and `updatedAt` fields. If we do,
    // mongoose will ignore the fields with the same names defined in `timestamps`.
    // Furthermore, if we control timestamps fields manually, the following error occurs upon
    // saving a document if strict mode is set to `throw`:
    // "Path `createdAt` is immutable and strict mode is set to throw."
  } as {
    [_ in StringLiteral<NonNullable<CrAt | UpAt>>]: z.ZodDate;
  });
  const def = getInternalDef(schema);
  def[MongooseSchemaOptionsSymbol] = {
    ...(def[MongooseSchemaOptionsSymbol] as Record<string, unknown> | undefined),
    timestamps: {
      createdAt: createdAtField == null ? false : createdAtField,
      updatedAt: updatedAtField == null ? false : updatedAtField,
    },
  };
  return schema;
};

export type MongooseSchemaTypeParameters<
  T,
  Parameter extends 'InstanceMethods' | 'QueryHelpers' | 'TStaticMethods' | 'TVirtuals',
> =
  T extends ZodMongoose<
    any,
    any,
    infer InstanceMethods,
    infer QueryHelpers,
    infer TStaticMethods,
    infer TVirtuals
  >
    ? {
        InstanceMethods: InstanceMethods;
        QueryHelpers: QueryHelpers;
        TStaticMethods: TStaticMethods;
        TVirtuals: TVirtuals;
      }[Parameter]
    : {};

const noCastFn = (value: any) => value;

export class MongooseZodBoolean extends M.SchemaTypes.Boolean {
  static schemaName = 'MongooseZodBoolean' as 'Boolean';
  cast = noCastFn;
}

export class MongooseZodDate extends M.SchemaTypes.Date {
  static schemaName = 'MongooseZodDate' as 'Date';
  cast = noCastFn;
}

export class MongooseZodNumber extends M.SchemaTypes.Number {
  static schemaName = 'MongooseZodNumber' as 'Number';
  cast = noCastFn;
}

export class MongooseZodString extends M.SchemaTypes.String {
  static schemaName = 'MongooseZodString' as 'String';
  cast = noCastFn;
}

export const registerCustomMongooseZodTypes = (): void => {
  Object.assign(M.Schema.Types, {
    MongooseZodBoolean,
    MongooseZodDate,
    MongooseZodNumber,
    MongooseZodString,
  });
};

export const bufferMongooseGetter = (value: unknown) =>
  value instanceof M.mongo.Binary ? value.buffer : value;
