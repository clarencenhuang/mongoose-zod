import M, {Schema as MongooseSchema, type SchemaOptions, type SchemaTypeOptions} from 'mongoose';
import z from 'zod';
import type {ZodSchema} from 'zod';
import {MongooseZodError} from './errors.js';
import {MongooseSchemaOptionsSymbol, ZodMongoose} from './extensions.js';
import {
  type MongooseSchemaTypeParameters,
  MongooseZodBoolean,
  MongooseZodDate,
  MongooseZodNumber,
  MongooseZodString,
  bufferMongooseGetter,
  registerCustomMongooseZodTypes,
} from './mongoose-helpers.js';
import type {DisableablePlugins, ToMongooseSchemaOptions, UnknownKeysHandling} from './mz-types.js';
import {setupState} from './setup.js';
import {getValidEnumValues, tryImportModule} from './utils.js';
import {
  type SchemaFeatures,
  getSchemaDef,
  getZodEnumEntries,
  isZodEnum,
  isZodType,
  unwrapZodSchema,
  zodInstanceofOriginalClasses,
} from './zod-helpers.js';

const {Mixed: MongooseMixed} = M.Schema.Types;
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalMongooseLean = M.Query.prototype.lean;

registerCustomMongooseZodTypes();

const mlvPlugin = tryImportModule('mongoose-lean-virtuals', import.meta);
const mldPlugin = tryImportModule('mongoose-lean-defaults', import.meta);
const mlgPlugin = tryImportModule('mongoose-lean-getters', import.meta);

// eslint-disable-next-line @typescript-eslint/ban-types
const getFixedOptionFn = (fn: Function) =>
  function (this: unknown, ...args: any[]) {
    const thisFixed = this && this instanceof M.Document ? this : undefined;
    return fn.apply(thisFixed, args);
  };

const getStrictOptionValue = (
  unknownKeys: UnknownKeysHandling | undefined,
  schemaFeatures: SchemaFeatures,
) => {
  const isStrictThrow =
    unknownKeys == null || unknownKeys === 'throw' || schemaFeatures.unknownKeys === 'strict';
  const isStrictFalse =
    unknownKeys === 'strip-unless-overridden' && schemaFeatures.unknownKeys === 'passthrough';
  return isStrictThrow ? 'throw' : !isStrictFalse;
};

const addMongooseSchemaFields = (
  zodSchema: z.ZodSchema,
  monSchema: MongooseSchema,
  context: {
    unknownKeys?: UnknownKeysHandling;
    fieldsStack?: string[];
    monSchemaOptions?: SchemaOptions;
    monTypeOptions?: SchemaTypeOptions<any>;
    typeKey?: string;
  },
): void => {
  const {
    fieldsStack = [],
    monSchemaOptions,
    monTypeOptions: monTypeOptionsFromSchema,
    unknownKeys,
  } = context;

  const addToField = fieldsStack.at(-1);
  const fieldPath = fieldsStack.join('.');
  const isRoot = addToField == null;

  const throwError = (message: string, noPath?: boolean) => {
    throw new MongooseZodError(`${noPath ? '' : `Path \`${fieldPath}\`: `}${message}`);
  };

  const {schema: zodSchemaFinal, features: schemaFeatures} = unwrapZodSchema(zodSchema);
  const zodSchemaFinalDef = getSchemaDef(zodSchemaFinal);
  const monMetadata = schemaFeatures.mongoose || {};

  const {
    mongooseTypeOptions: monTypeOptionsFromField,
    mongooseSchemaOptions: monSchemaOptionsFromField,
    unionSchemaType,
  } = schemaFeatures;
  const monTypeOptions = {...monTypeOptionsFromField, ...monTypeOptionsFromSchema};

  const {isOptional, isNullable} = schemaFeatures;
  const isRequired = !isOptional;
  const isFieldArray = 'array' in schemaFeatures;

  const mzOptions = [
    ['validate', monTypeOptions.mzValidate],
    ['required', monTypeOptions.mzRequired],
  ] as const;
  mzOptions.forEach(([origName]) => {
    const mzName = `mz${origName[0]?.toUpperCase()}${origName.slice(1)}`;
    if (mzName in monTypeOptions) {
      if (origName in monTypeOptions) {
        throwError(`Can't have both "${mzName}" and "${origName}" set`);
      }
      monTypeOptions[origName] = monTypeOptions[mzName];
      delete monTypeOptions[mzName];
    }
  });

  const commonFieldOptions: SchemaTypeOptions<any> = {
    required: isRequired,
    ...('default' in schemaFeatures
      ? {default: schemaFeatures.default}
      : // `mongoose-lean-defaults` will implicitly set default values on sub schemas.
        // It will result in sub documents being ALWAYS defined after using `.lean()`
        // and even optional fields of that schema having `undefined` values.
        // This looks very weird to me and even broke my production.
        // You need to explicitly set `default: undefined` to sub schemas to prevent such a behaviour.
        isFieldArray || isZodType(zodSchemaFinal, 'ZodObject')
        ? {default: undefined}
        : {}),
    ...(isFieldArray && {castNonArrays: false}),
    ...monTypeOptions,
  };

  const [[, mzValidate], [, mzRequired]] = mzOptions;

  if (mzValidate != null) {
    let mzv = mzValidate;
    if (typeof mzv === 'function') {
      mzv = getFixedOptionFn(mzv);
    } else if (!Array.isArray(mzv) && typeof mzv === 'object' && !(mzv instanceof RegExp)) {
      mzv.validator = getFixedOptionFn(mzv.validator);
    } else if (Array.isArray(mzv) && !(mzv[0] instanceof RegExp && typeof mzv[1] === 'string')) {
      const [firstElem, secondElem] = mzv;
      if (typeof firstElem === 'function' && typeof secondElem === 'string') {
        commonFieldOptions.mzValidate = [getFixedOptionFn(firstElem), secondElem];
      }
    }
    commonFieldOptions.validate = mzv;
  }
  if (mzRequired != null) {
    let mzr = mzRequired;
    if (typeof mzr === 'function') {
      mzr = getFixedOptionFn(mzr);
    } else if (Array.isArray(mzr) && typeof mzr[0] === 'function') {
      const [probablyFn] = mzr;
      if (typeof probablyFn === 'function') {
        mzr[0] = getFixedOptionFn(probablyFn);
      }
    }
    commonFieldOptions.required = mzr;
  }

  if (isRequired) {
    // eslint-disable-next-line no-lonely-if
    if (commonFieldOptions.required !== true) {
      throwError("Can't have `required` set to anything but true if `.optional()` not used");
    }
  } else if (commonFieldOptions.required === true) {
    throwError("Can't have `required` set to true and `.optional()` used");
  }

  if (isNullable && !isRoot) {
    const origRequired = commonFieldOptions.required;
    commonFieldOptions.required = function () {
      return this[addToField] === null
        ? false
        : typeof origRequired === 'function'
          ? origRequired.call(this)
          : isRequired;
    };
  }

  let fieldType: any;
  let errMsgAddendum = '';

  const typeKey = (isRoot ? monSchemaOptions?.typeKey : context.typeKey) ?? 'type';
  if (isZodType(zodSchemaFinal, 'ZodObject')) {
    const relevantSchema = isRoot
      ? monSchema
      : new MongooseSchema(
          {},
          {
            strict: getStrictOptionValue(unknownKeys, schemaFeatures),
            ...monSchemaOptionsFromField,
            typeKey,
            ...monMetadata.schemaOptions,
          },
        );
    const objectShape = (zodSchemaFinal as z.ZodObject<any>).shape;
    for (const [key, S] of Object.entries(objectShape) as [string, z.ZodTypeAny][]) {
      addMongooseSchemaFields(S, relevantSchema, {
        ...context,
        fieldsStack: [...fieldsStack, key],
        monTypeOptions: monMetadata.typeOptions?.[key],
        typeKey: monMetadata.schemaOptions?.typeKey ?? typeKey,
      });
    }
    if (isRoot) {
      return;
    }
    if (!('_id' in commonFieldOptions)) {
      commonFieldOptions._id = false;
    }
    fieldType = relevantSchema;
  } else if (isZodType(zodSchemaFinal, 'ZodNumber') || unionSchemaType === 'ZodNumber') {
    fieldType = MongooseZodNumber;
  } else if (isZodType(zodSchemaFinal, 'ZodString') || unionSchemaType === 'ZodString') {
    fieldType = MongooseZodString;
  } else if (isZodType(zodSchemaFinal, 'ZodDate') || unionSchemaType === 'ZodDate') {
    fieldType = MongooseZodDate;
  } else if (isZodType(zodSchemaFinal, 'ZodBoolean') || unionSchemaType === 'ZodBoolean') {
    fieldType = MongooseZodBoolean;
  } else if (isZodType(zodSchemaFinal, 'ZodLiteral')) {
    const literalValues = zodSchemaFinalDef.values as unknown[] | undefined;
    const literalValue = literalValues?.[0];
    const literalJsType = typeof literalValue;
    switch (literalJsType) {
      case 'boolean': {
        fieldType = MongooseZodBoolean;
        break;
      }
      case 'number': {
        fieldType = Number.isNaN(literalValue)
          ? MongooseMixed
          : Number.isFinite(literalValue)
            ? MongooseZodNumber
            : undefined;
        break;
      }
      case 'string': {
        fieldType = MongooseZodString;
        break;
      }
      case 'object': {
        if (!literalValue) {
          fieldType = MongooseMixed;
        }
        errMsgAddendum = 'object literals are not supported';
        break;
      }
      default: {
        errMsgAddendum = 'only boolean, number, string or null literals are supported';
      }
    }
  } else if (isZodEnum(zodSchemaFinal) || unionSchemaType === 'ZodEnum') {
    const unionOptions = Array.isArray(zodSchemaFinalDef.options)
      ? (zodSchemaFinalDef.options as z.ZodTypeAny[])
      : [];
    const enumSchemas = isZodEnum(zodSchemaFinal)
      ? [zodSchemaFinal as z.ZodTypeAny]
      : unionOptions.filter(isZodEnum);

    type EnumSchemaAnalysis =
      | {kind: 'string'; values: (string | number)[]}
      | {kind: 'number'; values: (string | number)[]}
      | {kind: 'mixed-native'; values: (string | number)[]}
      | {kind: 'invalid'; reason: string};

    const analyzeEnumSchema = (schema: z.ZodTypeAny): EnumSchemaAnalysis => {
      const entries = getZodEnumEntries(schema);
      if (!entries) {
        return {kind: 'invalid', reason: 'enum definition is missing'};
      }
      const enumValues = getValidEnumValues(entries);
      const rawValues = Object.values(entries);
      if (enumValues.length === 0) {
        return {kind: 'invalid', reason: 'only nonempty enums with string or number values are supported'};
      }

      const invalidValue = enumValues.find((value) => {
        const valueType = typeof value;
        return valueType !== 'string' && valueType !== 'number';
      });
      if (invalidValue !== undefined) {
        return {kind: 'invalid', reason: 'enum values must be strings or numbers'};
      }

      const typedEnumValues = enumValues as (string | number)[];
      const valueTypes = new Set(typedEnumValues.map((value) => typeof value));
      if (valueTypes.size === 1) {
        const [valueType] = [...valueTypes];
        if (
          valueType === 'string' &&
          rawValues.some((rawValue) => typeof rawValue === 'number')
        ) {
          return {kind: 'invalid', reason: 'only native enums can mix string and number values'};
        }
        return valueType === 'string'
          ? {kind: 'string', values: typedEnumValues}
          : {kind: 'number', values: typedEnumValues};
      }

      // Mixed string/number enums are only supported for native enums which include reverse numeric lookups
      const hasReverseNumericLookup = Object.entries(entries).some(([key, value]) => {
        if (key === '') {
          return false;
        }
        const parsedKey = Number(key);
        return (
          Number.isInteger(parsedKey) &&
          String(parsedKey) === key &&
          typeof value === 'string' &&
          value !== key
        );
      });

      const hasForwardNumericLookup = Object.entries(entries).some(([key, value]) => {
        return Number.isNaN(Number(key)) && typeof value === 'number';
      });

      if (hasReverseNumericLookup && hasForwardNumericLookup) {
        return {kind: 'mixed-native', values: typedEnumValues};
      }

      return {kind: 'invalid', reason: 'only native enums can mix string and number values'};
    };

    const analyses = enumSchemas.map(analyzeEnumSchema);

    if (analyses.length === 0) {
      errMsgAddendum = 'enum definition is missing';
    }

    const invalidAnalysis = analyses.find(
      (analysis): analysis is Extract<EnumSchemaAnalysis, {kind: 'invalid'}> =>
        analysis.kind === 'invalid',
    );

    if (!errMsgAddendum && invalidAnalysis) {
      errMsgAddendum = invalidAnalysis.reason;
    } else if (!errMsgAddendum) {
      const kinds = new Set(analyses.map((analysis) => analysis.kind));

      if (kinds.size === 1 && kinds.has('string')) {
        fieldType = MongooseZodString;
      } else if (kinds.size === 1 && kinds.has('number')) {
        fieldType = MongooseZodNumber;
      } else if (kinds.size === 1 && kinds.has('mixed-native')) {
        fieldType = MongooseMixed;
      } else if (kinds.has('mixed-native') || (kinds.has('string') && kinds.has('number'))) {
        fieldType = MongooseMixed;
      } else {
        errMsgAddendum = 'enum values must be strings or numbers';
      }
    }
  } else if (isZodType(zodSchema, 'ZodNaN') || isZodType(zodSchema, 'ZodNull')) {
    fieldType = MongooseMixed;
  } else if (isZodType(zodSchemaFinal, 'ZodMap')) {
    fieldType = Map;
  } else if (isZodType(zodSchemaFinal, 'ZodAny') || isZodType(zodSchemaFinal, 'ZodType')) {
    const instanceOfClass = zodInstanceofOriginalClasses.get(zodSchemaFinal);
    fieldType = instanceOfClass || MongooseMixed;
    // When using .lean(), it returns the inner representation of buffer fields, i.e.
    // instances of `mongo.Binary`. We can fix this with the getter that actually returns buffers
    if (instanceOfClass === M.Schema.Types.Buffer && !('get' in commonFieldOptions)) {
      commonFieldOptions.get = bufferMongooseGetter;
    }
  } else if (
    isZodType(zodSchemaFinal, 'ZodUnknown') ||
    isZodType(zodSchemaFinal, 'ZodRecord') ||
    isZodType(zodSchemaFinal, 'ZodUnion') ||
    isZodType(zodSchemaFinal, 'ZodTuple') ||
    isZodType(zodSchemaFinal, 'ZodDiscriminatedUnion') ||
    isZodType(zodSchemaFinal, 'ZodIntersection') ||
    isZodType(zodSchemaFinal, 'ZodTypeAny')
  ) {
    fieldType = MongooseMixed;
  }

  if (isRoot) {
    throw new MongooseZodError('You must provide object schema at root level');
  }

  // undefined, void, bigint, never, sets, promise, function, lazy, effects
  if (fieldType == null) {
    const typeName = zodSchemaFinal.constructor.name;
    throwError(`${typeName} type is not supported${errMsgAddendum ? ` (${errMsgAddendum})` : ''}`);
  }

  if (schemaFeatures.array) {
    for (let i = 0; i < schemaFeatures.array.wrapInArrayTimes; i++) {
      fieldType = [fieldType];
    }
  }

  monSchema.add({
    [addToField]: {
      ...commonFieldOptions,
      [typeKey]: fieldType,
    },
  });

  monSchema.paths[addToField]?.validate(function (value: any) {
    let schemaToValidate: ZodSchema = schemaFeatures.array?.originalArraySchema || zodSchemaFinal;

    if (isZodType(schemaToValidate, 'ZodObject')) {
      schemaToValidate = z.preprocess((obj) => {
        if (!obj || typeof obj !== 'object') {
          return obj;
        }
        // Do not shallow-copy the object until we find Binary we need to unwrap
        let objMaybeCopy = obj as Record<string, unknown>;
        for (const [k, v] of Object.entries(objMaybeCopy)) {
          if (v instanceof M.mongo.Binary) {
            if (objMaybeCopy === obj) {
              objMaybeCopy = {...obj};
            }
            objMaybeCopy[k] = v.buffer;
          }
        }
        return objMaybeCopy;
      }, schemaToValidate);
    }

    if (isNullable) {
      schemaToValidate = z.nullable(schemaToValidate);
    }

    const valueToParse =
      value &&
      typeof value === 'object' &&
      'toObject' in value &&
      typeof value.toObject === 'function'
        ? value.toObject()
        : value;

    const normalizedValue =
      valueToParse instanceof M.mongo.Binary ? valueToParse.buffer : valueToParse;

    schemaToValidate.parse(normalizedValue);

    return true;
  });
};

const isPluginDisabled = (name: keyof DisableablePlugins, option?: DisableablePlugins | true) =>
  option != null && (option === true || option[name]);

const ALL_PLUGINS_DISABLED: Record<keyof DisableablePlugins, true> = {
  leanDefaults: true,
  leanGetters: true,
  leanVirtuals: true,
};

export const toMongooseSchema = <Schema extends ZodMongoose<any, any>>(
  rootZodSchema: Schema,
  options: ToMongooseSchemaOptions = {},
) => {
  if (!(rootZodSchema instanceof ZodMongoose)) {
    throw new MongooseZodError('Root schema must be an instance of ZodMongoose');
  }

  const globalOptions = setupState.options?.defaultToMongooseSchemaOptions || {};
  const optionsFinal: ToMongooseSchemaOptions = {
    ...globalOptions,
    ...options,
    disablePlugins: {
      ...(globalOptions.disablePlugins === true
        ? {...ALL_PLUGINS_DISABLED}
        : globalOptions.disablePlugins),
      ...(options.disablePlugins === true ? {...ALL_PLUGINS_DISABLED} : options.disablePlugins),
    },
  };

  const {disablePlugins: dp, unknownKeys} = optionsFinal;

  const metadata = getSchemaDef(rootZodSchema);
  const innerTypeDef = metadata.innerType ? getSchemaDef(metadata.innerType) : undefined;
  const schemaOptionsFromField = innerTypeDef?.[MongooseSchemaOptionsSymbol];
  const {schemaOptions} = metadata.mongoose;

  const addMLVPlugin = mlvPlugin && !isPluginDisabled('leanVirtuals', dp);
  const addMLDPlugin = mldPlugin && !isPluginDisabled('leanDefaults', dp);
  const addMLGPlugin = mlgPlugin && !isPluginDisabled('leanGetters', dp);

  const schema = new MongooseSchema<
    z.infer<Schema>,
    any,
    MongooseSchemaTypeParameters<Schema, 'InstanceMethods'>,
    MongooseSchemaTypeParameters<Schema, 'QueryHelpers'>,
    Partial<MongooseSchemaTypeParameters<Schema, 'TVirtuals'>>,
    MongooseSchemaTypeParameters<Schema, 'TStaticMethods'>
  >(
    {},
    {
      id: false,
      minimize: false,
      strict: getStrictOptionValue(unknownKeys, unwrapZodSchema(rootZodSchema).features),
      ...schemaOptionsFromField,
      ...schemaOptions,
      query: {
        lean(leanOptions?: any) {
          return originalMongooseLean.call(
            this,
            typeof leanOptions === 'object' || leanOptions == null
              ? {
                  ...(addMLVPlugin && {virtuals: true}),
                  ...(addMLDPlugin && {defaults: true}),
                  ...(addMLGPlugin && {getters: true}),
                  versionKey: false,
                  ...leanOptions,
                }
              : leanOptions,
          );
        },
        ...schemaOptions?.query,
      },
    },
  );

  addMongooseSchemaFields(rootZodSchema, schema, {monSchemaOptions: schemaOptions, unknownKeys});

  addMLVPlugin && schema.plugin(mlvPlugin.module);
  addMLDPlugin && schema.plugin(mldPlugin.module?.default);
  addMLGPlugin && schema.plugin(mlgPlugin.module);

  return schema;
};
