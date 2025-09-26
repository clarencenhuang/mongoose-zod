/* eslint-disable @typescript-eslint/prefer-function-type */
import type {SchemaOptions, SchemaTypeOptions} from 'mongoose';
import {type ZodObject, z, core} from 'zod';
import type {PartialLaconic} from './types.js';

export const MongooseTypeOptionsSymbol = Symbol.for('MongooseTypeOptions');
export const MongooseSchemaOptionsSymbol = Symbol.for('MongooseSchemaOptions');

export interface MongooseMetadata<
  DocType,
  TInstanceMethods extends {} = {},
  QueryHelpers extends {} = {},
  TStaticMethods extends {} = {},
  TVirtuals extends {} = {},
> {
  typeOptions?: {
    [Field in keyof DocType]?: SchemaTypeOptions<DocType[Field], DocType>;
  };
  schemaOptions?: Omit<
    SchemaOptions<any, DocType, TInstanceMethods, QueryHelpers, TStaticMethods, TVirtuals>,
    // Actually does not work
    'castNonArrays'
  >;
}

type AnyZodType = z.ZodTypeAny;

type ZodTypeInternals<T extends AnyZodType = AnyZodType> = T extends z.ZodType<any, any, infer I> ? I : never;

export interface ZodMongoose<
  ZodType extends z.ZodTypeAny,
  DocType,
  TInstanceMethods extends {} = {},
  QueryHelpers extends {} = {},
  TStaticMethods extends {} = {},
  TVirtuals extends {} = {},
> extends z.ZodType<DocType & PartialLaconic<TVirtuals>, z.input<ZodType>> {
  _zod: core.$ZodCustomInternals<DocType & PartialLaconic<TVirtuals>, z.input<ZodType>> & {
    def: core.$ZodCustomDef<DocType & PartialLaconic<TVirtuals>> & {
      mongoose: MongooseMetadata<DocType, TInstanceMethods, QueryHelpers, TStaticMethods, TVirtuals>;
      innerType: ZodType;
    };
  };
}

class ZodMongooseClass {}

type ZodMongooseConstructor = {
  new (...args: any[]): ZodMongoose<z.ZodTypeAny, unknown>;
  create<
    ZT extends z.ZodObject<any>,
    DocType,
    TInstanceMethods extends {} = {},
    QueryHelpers extends {} = {},
    TStaticMethods extends {} = {},
    TVirtuals extends {} = {},
  >(
    def: {
      innerType: ZT;
      mongoose: MongooseMetadata<DocType, TInstanceMethods, QueryHelpers, TStaticMethods, TVirtuals>;
    },
  ): ZodMongoose<ZT, DocType, TInstanceMethods, QueryHelpers, TStaticMethods, TVirtuals>;
};

const ensureZodMongoosePrototype = (() => {
  let isInitialized = false;
  return (schema: z.ZodTypeAny) => {
    if (!isInitialized) {
      Object.setPrototypeOf(ZodMongooseClass.prototype, Object.getPrototypeOf(schema));
      isInitialized = true;
    }
    Object.setPrototypeOf(schema, ZodMongooseClass.prototype);
  };
})();

const createZodMongoose = <
  ZT extends z.ZodObject<any>,
  DocType,
  TInstanceMethods extends {} = {},
  QueryHelpers extends {} = {},
  TStaticMethods extends {} = {},
  TVirtuals extends {} = {},
>({innerType, mongoose}: {innerType: ZT; mongoose: MongooseMetadata<DocType, TInstanceMethods, QueryHelpers, TStaticMethods, TVirtuals>}): ZodMongoose<
  ZT,
  DocType,
  TInstanceMethods,
  QueryHelpers,
  TStaticMethods,
  TVirtuals
> => {
  const schema = z.custom<DocType & PartialLaconic<TVirtuals>>(() => true) as z.ZodType<
    DocType & PartialLaconic<TVirtuals>,
    z.input<ZT>
  >;
  const def = getInternalDef(schema);
  def.type = 'custom';
  def.check = 'custom';
  def.fn = () => true;
  def.mongoose = mongoose;
  def.innerType = innerType;
  ensureZodMongoosePrototype(schema);
  return schema as ZodMongoose<ZT, DocType, TInstanceMethods, QueryHelpers, TStaticMethods, TVirtuals>;
};

export const ZodMongoose = ZodMongooseClass as unknown as ZodMongooseConstructor;

ZodMongoose.create = (def) => createZodMongoose(def);

declare module 'zod' {
  interface ZodTypeDef {
    [MongooseTypeOptionsSymbol]?: SchemaTypeOptions<any>;
    [MongooseSchemaOptionsSymbol]?: SchemaOptions;
  }

  interface ZodType {
    mongooseTypeOptions: <T extends this>(
      this: T,
      options: SchemaTypeOptions<T['_output']>,
    ) => T;
    mongoose: (...args: any[]) => any;
  }
}

export const toZodMongooseSchema = function <
  ZO extends ZodObject<any>,
  TInstanceMethods extends {} = {},
  QueryHelpers extends {} = {},
  TStaticMethods extends {} = {},
  TVirtuals extends {} = {},
>(
  zObject: ZO,
  metadata: MongooseMetadata<
    ZO['_output'],
    TInstanceMethods,
    QueryHelpers,
    TStaticMethods,
    TVirtuals
  > = {},
) {
  return ZodMongoose.create({mongoose: metadata, innerType: zObject});
};

export const addMongooseToZodPrototype = (toZ: typeof z | null) => {
  if (toZ === null) {
    // eslint-disable-next-line disable-autofix/@typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-condition
    if (z.ZodObject.prototype.mongoose !== undefined) {
      delete z.ZodObject.prototype.mongoose;
    }
    // eslint-disable-next-line disable-autofix/@typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-condition
  } else if (toZ.ZodObject.prototype.mongoose === undefined) {
    toZ.ZodObject.prototype.mongoose = function (metadata = {}) {
      return toZodMongooseSchema(this, metadata);
    };
  }
};

export const addMongooseTypeOptions = function <T extends z.ZodTypeAny>(
  zObject: T,
  options: SchemaTypeOptions<T['_output']>,
) {
  const def = getInternalDef(zObject);
  def[MongooseTypeOptionsSymbol] = {
    ...(def[MongooseTypeOptionsSymbol] as SchemaTypeOptions<T['_output']> | undefined),
    ...options,
  };
  return zObject;
};

export const addMongooseTypeOptionsToZodPrototype = (toZ: typeof z | null) => {
  if (toZ === null) {
    // eslint-disable-next-line disable-autofix/@typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-condition
    if (z.ZodType.prototype.mongooseTypeOptions !== undefined) {
      delete z.ZodType.prototype.mongooseTypeOptions;
    }
    // eslint-disable-next-line disable-autofix/@typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-condition
  } else if (toZ.ZodType.prototype.mongooseTypeOptions === undefined) {
    toZ.ZodType.prototype.mongooseTypeOptions = function (options: SchemaTypeOptions<any, any>) {
      return addMongooseTypeOptions(this, options);
    };
  }
};

declare module 'mongoose' {
  interface MZValidateFn<T, ThisType> {
    (this: ThisType, value: T): boolean;
  }

  interface MZLegacyAsyncValidateFn<T, ThisType> {
    (this: ThisType, value: T, done: (result: boolean) => void): void;
  }

  interface MZAsyncValidateFn<T, ThisType> {
    (this: ThisType, value: T): Promise<boolean>;
  }

  interface MZValidateOpts<T, ThisType> {
    msg?: string;
    message?: string | ValidatorMessageFn;
    type?: string;
    validator:
      | MZValidateFn<T, ThisType>
      | MZLegacyAsyncValidateFn<T, ThisType>
      | MZAsyncValidateFn<T, ThisType>;
  }

  type MZSchemaValidator<T, ThisType> =
    | RegExp
    | [RegExp, string]
    | MZValidateFn<T, ThisType>
    | [MZValidateFn<T, ThisType>, string]
    | MZValidateOpts<T, ThisType>;

  interface MZRequiredFn<ThisType> {
    (this: ThisType): boolean;
  }

  // eslint-disable-next-line @typescript-eslint/no-shadow
  interface SchemaTypeOptions<T, ThisType = any> {
    mzValidate?: MZSchemaValidator<Exclude<T, undefined>, ThisType | undefined>;
    mzRequired?:
      | boolean
      | MZRequiredFn<ThisType | null>
      | [boolean, string]
      | [MZRequiredFn<ThisType | null>, string];
  }
}

export {z} from 'zod';
const getInternalDef = (schema: z.ZodTypeAny) =>
  ((schema as unknown as { _zod?: { def?: Record<PropertyKey, unknown> }; _def?: Record<PropertyKey, unknown> })._zod?.def ??
    (schema as unknown as { _def?: Record<PropertyKey, unknown> })._def ??
    ({} as Record<PropertyKey, unknown>));
