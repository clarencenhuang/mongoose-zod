/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
import M from 'mongoose';
import {z} from 'zod';
import type {ZodSchema, ZodTypeAny} from 'zod';
import {
  type MongooseMetadata,
  getMongooseSchemaOptions,
  getMongooseTypeOptions,
  getZodMongooseInternal,
  isZodMongoose,
} from './extensions.js';

export interface ZodTypes {
  ZodAny: z.ZodAny;
  ZodArray: z.ZodArray<any>;
  ZodBigInt: z.ZodBigInt;
  ZodBoolean: z.ZodBoolean;
  ZodDate: z.ZodDate;
  ZodDefault: z.ZodDefault<any>;
  ZodEnum: z.ZodEnum<any>;
  ZodFunction: z.ZodFunction<any, any>;
  ZodIntersection: z.ZodIntersection<any, any>;
  ZodLazy: z.ZodLazy<any>;
  ZodLiteral: z.ZodLiteral<any>;
  ZodMap: z.ZodMap<any, any>;
  ZodNaN: z.ZodNaN;
  ZodNull: z.ZodNull;
  ZodNullable: z.ZodNullable<any>;
  ZodNumber: z.ZodNumber;
  ZodObject: z.ZodObject<any>;
  ZodOptional: z.ZodOptional<any>;
  ZodUndefined: z.ZodUndefined;
  ZodNever: z.ZodNever;
  ZodPromise: z.ZodPromise<any>;
  ZodRecord: z.ZodRecord<any, any>;
  ZodSet: z.ZodSet<any>;
  ZodString: z.ZodString;
  ZodTuple: z.ZodTuple<any>;
  ZodUnion: z.ZodUnion<any>;
  ZodDiscriminatedUnion: z.ZodDiscriminatedUnion<any, any>;
  ZodUnknown: z.ZodUnknown;
  ZodVoid: z.ZodVoid;
  ZodPipe: z.ZodPipe<any, any>;
  ZodTransform: z.ZodTransform<any>;
  ZodCustom: z.ZodTypeAny;
  ZodType: z.ZodType;
  ZodTypeAny: z.ZodTypeAny;
}

export const isZodType = <TypeName extends keyof ZodTypes>(
  schema: object,
  typeName: TypeName,
): schema is ZodTypes[TypeName] => {
  return schema.constructor.name === typeName;
};

export interface SchemaFeatures {
  default?: any;
  isOptional?: boolean;
  isNullable?: boolean;
  unknownKeys?: 'strict' | 'passthrough';
  unionSchemaType?: keyof ZodTypes;
  array?: {
    wrapInArrayTimes: number;
    originalArraySchema: z.ZodArray<any>;
  };
  mongoose?: MongooseMetadata<any>;
  mongooseTypeOptions?: M.SchemaTypeOptions<any>;
  mongooseSchemaOptions?: M.SchemaOptions;
}

export const unwrapZodSchema = (
  schema: ZodSchema,
  options: {doNotUnwrapArrays?: boolean} = {},
  _features: SchemaFeatures = {},
): {schema: ZodSchema; features: SchemaFeatures} => {
  const monTypeOptions = getMongooseTypeOptions(schema);
  _features.mongooseTypeOptions ||= monTypeOptions;
  const monSchemaOptions = getMongooseSchemaOptions(schema);
  _features.mongooseSchemaOptions ||= monSchemaOptions;

  if (
    isZodType(schema, 'ZodNull') ||
    (isZodType(schema, 'ZodLiteral') && schema._def.values?.includes(null))
  ) {
    _features.isNullable = true;
  }

  if (isZodType(schema, 'ZodNullable')) {
    return unwrapZodSchema(schema._def.innerType, options, {
      ..._features,
      isNullable: true,
    });
  }

  if (isZodType(schema, 'ZodUnion')) {
    const unionSchemas = schema._def.options as z.ZodSchema[];
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
    const uniqueUnionSchemaTypes = [
      ...new Set(unionSchemas.map((v) => v.constructor.name as keyof ZodTypes)),
    ];
    if (uniqueUnionSchemaTypes.length === 1) {
      _features.unionSchemaType ??= uniqueUnionSchemaTypes[0];
    }
  }

  if (isZodMongoose(schema)) {
    const internal = getZodMongooseInternal(schema);
    return unwrapZodSchema(internal.innerType, options, {
      ..._features,
      mongoose: internal.mongoose,
    });
  }

  // Remove `strict` or `passthrough` feature - set to strip mode (default)
  if (isZodType(schema, 'ZodObject')) {
    const {catchall} = schema._def;
    if (catchall && isZodType(catchall, 'ZodNever')) {
      return unwrapZodSchema(schema.strip(), options, {..._features, unknownKeys: 'strict'});
    }
    if (catchall && isZodType(catchall, 'ZodUnknown')) {
      return unwrapZodSchema(schema.strip(), options, {..._features, unknownKeys: 'passthrough'});
    }
  }

  if (isZodType(schema, 'ZodOptional')) {
    return unwrapZodSchema(schema.unwrap(), options, {..._features, isOptional: true});
  }

  if (isZodType(schema, 'ZodDefault')) {
    const defaultDef = schema._def.defaultValue;
    const defaultValue = typeof defaultDef === 'function' ? defaultDef() : defaultDef;
    return unwrapZodSchema(
      schema._def.innerType,
      options,
      // Only top-most default value ends up being used
      // (in case of `<...>.default(1).default(2)`, `2` will be used as the default value)
      'default' in _features ? _features : {..._features, default: defaultValue},
    );
  }

  if (isZodType(schema, 'ZodArray') && !options.doNotUnwrapArrays) {
    const wrapInArrayTimes = Number(_features.array?.wrapInArrayTimes || 0) + 1;
    return unwrapZodSchema(schema._def.element, options, {
      ..._features,
      array: {
        ..._features.array,
        wrapInArrayTimes,
        originalArraySchema: _features.array?.originalArraySchema || schema,
      },
    });
  }

  return {schema, features: _features};
};

export const zodInstanceofOriginalClasses = new WeakMap<ZodTypeAny, new (...args: any[]) => any>();

export const mongooseZodCustomType = <T extends keyof typeof M.Types & keyof typeof M.Schema.Types>(
  typeName: T,
  params?: Parameters<typeof z.instanceof>[1],
) => {
  const instanceClass = typeName === 'Buffer' ? Buffer : M.Types[typeName];
  const typeClass = M.Schema.Types[typeName];

  type TFixed = T extends 'Buffer' ? BufferConstructor : (typeof M.Types)[T];

  const result = z.instanceof(instanceClass, params) as z.ZodType<InstanceType<TFixed>>;
  zodInstanceofOriginalClasses.set(result, typeClass);

  return result;
};
