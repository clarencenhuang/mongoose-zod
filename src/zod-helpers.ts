/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
import M from 'mongoose';
import {z} from 'zod';
import type {ZodTypeAny} from 'zod';
import {
  type MongooseMetadata,
  MongooseSchemaOptionsSymbol,
  MongooseTypeOptionsSymbol,
  ZodMongoose,
} from './extensions.js';

export const getSchemaDef = (schema: ZodTypeAny): Record<PropertyKey, any> => {
  const internalDef = ((schema as unknown as { _zod?: { def?: unknown }; _def?: unknown })._zod?.def ??
    (schema as unknown as { _def?: unknown })._def) as Record<PropertyKey, any> | undefined;
  return internalDef ?? {};
};

const typeNameMap: Record<string, string> = {
  ZodAny: 'any',
  ZodArray: 'array',
  ZodBigInt: 'bigint',
  ZodBoolean: 'boolean',
  ZodDate: 'date',
  ZodDefault: 'default',
  ZodEffects: 'transform',
  ZodEnum: 'enum',
  ZodFunction: 'function',
  ZodIntersection: 'intersection',
  ZodLazy: 'lazy',
  ZodLiteral: 'literal',
  ZodMap: 'map',
  ZodNaN: 'nan',
  ZodNull: 'null',
  ZodNullable: 'nullable',
  ZodNumber: 'number',
  ZodObject: 'object',
  ZodOptional: 'optional',
  ZodUndefined: 'undefined',
  ZodPromise: 'promise',
  ZodRecord: 'record',
  ZodSet: 'set',
  ZodString: 'string',
  ZodTuple: 'tuple',
  ZodUnion: 'union',
  ZodDiscriminatedUnion: 'union',
  ZodUnknown: 'unknown',
  ZodVoid: 'void',
  ZodTypeAny: 'any',
  ZodType: 'custom',
};

export const isZodType = (schema: ZodTypeAny, typeName: string) => {
  const ctorName = schema.constructor.name;
  if (ctorName === typeName) {
    return true;
  }
  const defType = getSchemaDef(schema).type;
  return defType === (typeNameMap[typeName] ?? typeName);
};

export const isZodEnum = (schema: ZodTypeAny): boolean => schema.constructor.name === 'ZodEnum';

export const getZodEnumEntries = (
  schema: ZodTypeAny,
): Record<string, string | number> | undefined => {
  if (!isZodEnum(schema)) {
    return undefined;
  }
  const {entries} = getSchemaDef(schema);
  return entries && typeof entries === 'object' ? (entries as Record<string, string | number>) : undefined;
};

export interface SchemaFeatures {
  default?: any;
  isOptional?: boolean;
  isNullable?: boolean;
  unknownKeys?: 'strict' | 'passthrough';
  unionSchemaType?: string;
  array?: {
    wrapInArrayTimes: number;
    originalArraySchema: z.ZodArray<any>;
  };
  mongoose?: MongooseMetadata<any>;
  mongooseTypeOptions?: M.SchemaTypeOptions<any>;
  mongooseSchemaOptions?: M.SchemaOptions;
}

export const unwrapZodSchema = (
  schema: ZodTypeAny,
  options: {doNotUnwrapArrays?: boolean} = {},
  _features: SchemaFeatures = {},
): {schema: ZodTypeAny; features: SchemaFeatures} => {
  const def = getSchemaDef(schema);
  const monTypeOptions = def[MongooseTypeOptionsSymbol];
  _features.mongooseTypeOptions ||= monTypeOptions;
  const monSchemaOptions = def[MongooseSchemaOptionsSymbol];
  _features.mongooseSchemaOptions ||= monSchemaOptions;

  if (isZodType(schema, 'null') || (isZodType(schema, 'literal') && def.values?.includes?.(null))) {
    _features.isNullable = true;
  }

  if (isZodType(schema, 'nullable')) {
    return unwrapZodSchema(def.innerType, options, {
      ..._features,
      isNullable: true,
    });
  }

  if (isZodType(schema, 'union')) {
    const unionSchemas = def.options as ZodTypeAny[];
    const unwrappedSchemas = unionSchemas.map((s) => unwrapZodSchema(s, {doNotUnwrapArrays: true}));

    _features.isNullable ||= unwrappedSchemas.some(({features}) => features.isNullable);
    _features.isOptional ||= unwrappedSchemas.some(({features}) => features.isOptional);

    if (!('default' in _features)) {
      // TODO use `findLast` with node 18
      const lastSchemaWithDefaultValue = unwrappedSchemas
        .filter((v) => 'default' in v.features)
        .at(-1);
      if (lastSchemaWithDefaultValue) {
        _features.default = lastSchemaWithDefaultValue.features.default;
      }
    }

    // TODO
    const uniqueUnionSchemaTypes = [...new Set(unionSchemas.map((v) => v.constructor.name))];
    if (uniqueUnionSchemaTypes.length === 1) {
      _features.unionSchemaType ??= uniqueUnionSchemaTypes[0];
    }
  }

  if (schema instanceof ZodMongoose) {
    const schemaDef = getSchemaDef(schema);
    return unwrapZodSchema(schemaDef.innerType, options, {
      ..._features,
      mongoose: schemaDef.mongoose,
    });
  }

  // Remove `strict` or `passthrough` feature - set to strip mode (default)
  if (isZodType(schema, 'object')) {
    const catchallSchema = def.catchall as ZodTypeAny | undefined;
    let mode: 'strip' | 'strict' | 'passthrough' = 'strip';
    if (catchallSchema) {
      const catchallType = getSchemaDef(catchallSchema).type;
      if (catchallType === 'never') {
        mode = 'strict';
      } else if (catchallType !== 'undefined') {
        mode = 'passthrough';
      }
    }
    if (mode !== 'strip') {
      return unwrapZodSchema(
        (schema as z.ZodObject<any>).strip(),
        options,
        {..._features, unknownKeys: mode},
      );
    }
  }

  if (isZodType(schema, 'optional')) {
    return unwrapZodSchema((schema as z.ZodOptional<any>).unwrap(), options, {
      ..._features,
      isOptional: true,
    });
  }

  if (isZodType(schema, 'default')) {
    const defaultValRaw = def.defaultValue;
    const defaultVal = typeof defaultValRaw === 'function' ? defaultValRaw() : defaultValRaw;
    return unwrapZodSchema(
      def.innerType,
      options,
      // Only top-most default value ends up being used
      // (in case of `<...>.default(1).default(2)`, `2` will be used as the default value)
      'default' in _features ? _features : {..._features, default: defaultVal},
    );
  }

  if (isZodType(schema, 'readonly')) {
    return unwrapZodSchema((schema as z.ZodReadonly<any>).unwrap(), options, {..._features});
  }

  if (isZodType(schema, 'array') && !options.doNotUnwrapArrays) {
    const wrapInArrayTimes = Number(_features.array?.wrapInArrayTimes || 0) + 1;
    return unwrapZodSchema(def.element as ZodTypeAny, options, {
      ..._features,
      array: {
        ..._features.array,
        wrapInArrayTimes,
        originalArraySchema: (_features.array?.originalArraySchema || schema) as z.ZodArray<any>,
      },
    });
  }

  return {schema, features: _features};
};

export const zodInstanceofOriginalClasses = new WeakMap<ZodTypeAny, new (...args: any[]) => any>();

type InstanceofParams = {message?: string} | undefined;

export const mongooseZodCustomType = <T extends keyof typeof M.Types & keyof typeof M.Schema.Types>(
  typeName: T,
  params?: InstanceofParams,
) => {
  const instanceClass = typeName === 'Buffer' ? Buffer : M.Types[typeName];
  const typeClass = M.Schema.Types[typeName];

  type TFixed = T extends 'Buffer' ? BufferConstructor : (typeof M.Types)[T];

  const result = z.instanceof(instanceClass, params) as z.ZodType<InstanceType<TFixed>>;
  zodInstanceofOriginalClasses.set(result, typeClass);

  return result;
};
