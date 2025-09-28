import M, {Schema as MongooseSchema, type SchemaOptions, type SchemaTypeOptions} from 'mongoose';
import z from 'zod';
import type {ZodSchema} from 'zod';
import {MongooseZodError} from './errors.js';
import type {ZodMongoose} from './extensions.js';
import {getMongooseSchemaOptions, getZodMongooseInternal, isZodMongoose} from './extensions.js';
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
  isZodType,
  unwrapZodSchema,
  zodInstanceofOriginalClasses,
} from './zod-helpers.js';

const {Mixed: MongooseMixed} = M.Schema.Types;
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalMongooseLean = M.Query.prototype.lean;

registerCustomMongooseZodTypes();

const mlvPlugin = tryImportModule('mongoose-lean-virtuals', import.meta.url);
const mldPlugin = tryImportModule('mongoose-lean-defaults', import.meta.url);
const mlgPlugin = tryImportModule('mongoose-lean-getters', import.meta.url);

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
    const shapeEntries = Object.entries(zodSchemaFinal.shape) as [string, ZodSchema][];
    for (const [key, S] of shapeEntries) {
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
    const literalValues = zodSchemaFinal._def.values ?? [];
    if (literalValues.length !== 1) {
      errMsgAddendum = 'multiple literal values are not supported';
    }
    const literalValue = literalValues[0];
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
  } else if (isZodType(zodSchemaFinal, 'ZodEnum')) {
    const entries = zodSchemaFinal.enum || {};
    const hasNativeEnumShape = Object.entries(entries).some(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value) !== key;
      }
      return true;
    });
    const rawOptions = (zodSchemaFinal as any).options;
    const enumValues = hasNativeEnumShape
      ? getValidEnumValues(entries)
      : Array.isArray(rawOptions)
        ? [...rawOptions]
        : getValidEnumValues(entries);
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      errMsgAddendum = 'enum must contain at least one value';
    } else if (enumValues.every((v) => typeof v === 'string')) {
      fieldType = MongooseZodString;
    } else if (enumValues.every((v) => typeof v === 'number')) {
      fieldType = MongooseZodNumber;
    } else {
      if (hasNativeEnumShape && enumValues.every((v) => ['string', 'number'].includes(typeof v))) {
        fieldType = MongooseMixed;
      } else {
        errMsgAddendum =
          'only nonempty zod enums with values of a single primitive type (string or number) are supported';
      }
    }
  } else if (isZodType(zodSchema, 'ZodNaN') || isZodType(zodSchema, 'ZodNull')) {
    fieldType = MongooseMixed;
  } else if (isZodType(zodSchemaFinal, 'ZodMap')) {
    fieldType = Map;
  } else if (isZodType(zodSchemaFinal, 'ZodAny') || isZodType(zodSchemaFinal, 'ZodCustom')) {
    const instanceOfClass = zodInstanceofOriginalClasses.get(zodSchemaFinal);
    fieldType = instanceOfClass || MongooseMixed;
    // When using .lean(), it returns the inner representation of buffer fields, i.e.
    // instances of `mongo.Binary`. We can fix this with the getter that actually returns buffers
    if (instanceOfClass === M.Schema.Types.Buffer && !('get' in commonFieldOptions)) {
      commonFieldOptions.get = bufferMongooseGetter;
    }
  } else if (isZodType(zodSchemaFinal, 'ZodPipe') || isZodType(zodSchemaFinal, 'ZodTransform')) {
    errMsgAddendum = 'only refinements are supported';
  } else if (
    isZodType(zodSchemaFinal, 'ZodUnknown') ||
    isZodType(zodSchemaFinal, 'ZodRecord') ||
    isZodType(zodSchemaFinal, 'ZodUnion') ||
    isZodType(zodSchemaFinal, 'ZodTuple') ||
    isZodType(zodSchemaFinal, 'ZodDiscriminatedUnion') ||
    isZodType(zodSchemaFinal, 'ZodIntersection') ||
    isZodType(zodSchemaFinal, 'ZodTypeAny') ||
    isZodType(zodSchemaFinal, 'ZodType')
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

    let valueToParse =
      value &&
      typeof value === 'object' &&
      'toObject' in value &&
      typeof value.toObject === 'function'
        ? value.toObject()
        : value;

    if (valueToParse instanceof M.mongo.Binary) {
      valueToParse = valueToParse.buffer;
    }

    schemaToValidate.parse(valueToParse);

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

export const toMongooseSchema = (
  rootZodSchema: ZodMongoose,
  options: ToMongooseSchemaOptions = {},
) => {
  if (!isZodMongoose(rootZodSchema)) {
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

  const internal = getZodMongooseInternal(rootZodSchema);
  const schemaOptionsFromField = internal.innerType
    ? getMongooseSchemaOptions(internal.innerType)
    : undefined;
  const {schemaOptions = {}} = internal.mongoose;

  const addMLVPlugin = mlvPlugin && !isPluginDisabled('leanVirtuals', dp);
  const addMLDPlugin = mldPlugin && !isPluginDisabled('leanDefaults', dp);
  const addMLGPlugin = mlgPlugin && !isPluginDisabled('leanGetters', dp);

  const schema = new MongooseSchema(
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
    } as SchemaOptions,
  ) as MongooseSchema<any, any, any, any, any, any>;

  addMongooseSchemaFields(rootZodSchema, schema, {monSchemaOptions: schemaOptions, unknownKeys});

  addMLVPlugin && schema.plugin(mlvPlugin.module);
  addMLDPlugin && schema.plugin(mldPlugin.module?.default);
  addMLGPlugin && schema.plugin(mlgPlugin.module);

  return schema;
};
