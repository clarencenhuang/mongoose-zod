import {MongoMemoryServer} from 'mongodb-memory-server';
import M from 'mongoose';
import {z} from 'zod';
import {toMongooseSchema} from '../src/index.js';
import * as utils from '../src/utils.js';
import {getSchemaPlugins, importModule} from './shared.js';

const TEST_USERNAME = 'mongoose-zod';

  type LeanUserVirtual = {username?: string; u?: string};
  type LeanUserGetter = {username?: string};
  type LeanUserDefaults = {__v?: number};

describe('Plugins', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await M.connect(mongoServer.getUri(), {});
  });

  afterAll(async () => {
    await mongoServer.stop();
    await M.disconnect();
  });

  beforeEach(() => {
    for (const modelName of M.connection.modelNames()) {
      M.deleteModel(modelName);
    }
  });

  describe('mongoose-lean-virtuals', () => {
    it('Automatically adds `mongoose-lean-virtuals` plugin if installed', () => {
      const Schema = toMongooseSchema(z.object({}).mongoose());

      expect(getSchemaPlugins(Schema)).toContain(importModule('mongoose-lean-virtuals'));
    });

    it('Does not add `mongoose-lean-virtuals` plugin if not installed', () => {
      const spy = jest.spyOn(utils, 'tryImportModule').mockReturnValue(null);

      const Schema = toMongooseSchema(z.object({}).mongoose());

      expect(getSchemaPlugins(Schema)).not.toContain(importModule('mongoose-lean-virtuals'));

      spy.mockRestore();
    });

    it.each([
      {
        how: 'disable plugin only',
        disablePlugins: {leanVirtuals: true},
      },
      {
        how: 'disable all plugins',
        disablePlugins: true as const,
      },
    ])(
      'Does not add `mongoose-lean-virtuals` plugin if asked not to ($how)',
      ({disablePlugins}) => {
        const Schema = toMongooseSchema(z.object({}).mongoose(), {
          disablePlugins,
        });

        expect(getSchemaPlugins(Schema)).not.toContain(importModule('mongoose-lean-virtuals'));
      },
    );

    const UserWithVirtual = M.model(
      'UserWithVirtual',
      toMongooseSchema(
        z.object({username: z.string()}).mongoose({
          schemaOptions: {
            virtuals: {
              u: {
                get(this: any): string | undefined {
                  return this.username;
                },
              },
            },
          },
        }),
      ),
    );

    it('`mongoose-lean-virtuals` plugin works and does not require specifying "virtuals: true"', async () => {
      await new UserWithVirtual({username: TEST_USERNAME}).save();
      const user = await UserWithVirtual.findOne({username: TEST_USERNAME}).lean();
      const userVirtual = user as LeanUserVirtual;

      expect(userVirtual?.username).toBe(TEST_USERNAME);
      expect(userVirtual?.u).toEqual(userVirtual?.username);
    });

    it('Allows to override "virtuals: true" when using .lean()', async () => {
      await new UserWithVirtual({username: TEST_USERNAME}).save();
      const user = await UserWithVirtual.findOne({username: TEST_USERNAME}).lean({virtuals: false});
      const userVirtual = user as LeanUserVirtual | null;

      expect(userVirtual?.username).toBe(TEST_USERNAME);
      expect(userVirtual?.u).toEqual(undefined);
    });
  });

  describe('mongoose-lean-defaults', () => {
    it('Automatically adds `mongoose-lean-defaults` plugin if installed', () => {
      const Schema = toMongooseSchema(z.object({}).mongoose());

      expect(getSchemaPlugins(Schema)).toContain(importModule('mongoose-lean-defaults').default);
    });

    it('Does not add `mongoose-lean-defaults` plugin if not installed', () => {
      const spy = jest.spyOn(utils, 'tryImportModule').mockReturnValue(null);

      const Schema = toMongooseSchema(z.object({}).mongoose());

      expect(getSchemaPlugins(Schema)).not.toContain(importModule('mongoose-lean-defaults'));

      spy.mockRestore();
    });

    it.each([
      {
        how: 'disable plugin only',
        disablePlugins: {leanDefaults: true},
      },
      {
        how: 'disable all plugins',
        disablePlugins: true as const,
      },
    ])(
      'Does not add `mongoose-lean-defaults` plugin if asked not to ($how)',
      ({disablePlugins}) => {
        const Schema = toMongooseSchema(z.object({}).mongoose(), {
          disablePlugins,
        });

        expect(getSchemaPlugins(Schema)).not.toContain(importModule('mongoose-lean-defaults'));
      },
    );

    const UserWithNoDefault = M.model(
      'UserWithNoDefault',
      toMongooseSchema(
        z
          .object({username: z.string(), registered: z.boolean().optional()})
          .mongoose({schemaOptions: {collection: 'mongoose-lean-defaults'}}),
      ),
    );

    const UserWithDefault = M.model(
      'UserWithDefault',
      toMongooseSchema(
        z
          .object({username: z.string(), registered: z.boolean().default(false)})
          .mongoose({schemaOptions: {collection: 'mongoose-lean-defaults'}}),
      ),
    );

    it('`mongoose-lean-defaults` plugin works and does not require specifying "defaults: true"', async () => {
      const userRaw = await new UserWithNoDefault({username: TEST_USERNAME}).save();

      expect(userRaw.username).toBe(TEST_USERNAME);
      expect(userRaw.registered).toBe(undefined);

      const user = await UserWithDefault.findOne({username: TEST_USERNAME}).lean();

      expect(user?.username).toBe(TEST_USERNAME);
      expect(user?.registered).toEqual(false);
    });

    it('Allows to override "defaults: true" when using .lean()', async () => {
      const userRaw = await new UserWithNoDefault({username: TEST_USERNAME}).save();

      expect(userRaw.username).toBe(TEST_USERNAME);
      expect(userRaw.registered).toBe(undefined);

      const user = await UserWithDefault.findOne({username: TEST_USERNAME}).lean({defaults: false});

      expect(user?.username).toBe(TEST_USERNAME);
      expect(user?.registered).toEqual(undefined);
    });
  });

  describe('mongoose-lean-getters', () => {
    it('Automatically adds `mongoose-lean-getters` plugin if installed', () => {
      const Schema = toMongooseSchema(z.object({}).mongoose());

      expect(getSchemaPlugins(Schema)).toContain(importModule('mongoose-lean-getters'));
    });

    it('Does not add `mongoose-lean-getters` plugin if not installed', () => {
      const spy = jest.spyOn(utils, 'tryImportModule').mockReturnValue(null);

      const Schema = toMongooseSchema(z.object({}).mongoose());

      expect(getSchemaPlugins(Schema)).not.toContain(importModule('mongoose-lean-getters'));

      spy.mockRestore();
    });

    it.each([
      {
        how: 'disable plugin only',
        disablePlugins: {leanGetters: true},
      },
      {
        how: 'disable all plugins',
        disablePlugins: true as const,
      },
    ])('Does not add `mongoose-lean-getters` plugin if asked not to ($how)', ({disablePlugins}) => {
      const Schema = toMongooseSchema(z.object({}).mongoose(), {
        disablePlugins,
      });

      expect(getSchemaPlugins(Schema)).not.toContain(importModule('mongoose-lean-getters'));
    });

    const UserWithGetter = M.model(
      'UserWithGetter',
      toMongooseSchema(
        z.object({username: z.string()}).mongoose({
          typeOptions: {
            username: {
              get(value: string) {
                return value.toUpperCase();
              },
            },
          },
        }),
      ),
    );

    it('`mongoose-lean-getters` plugin works and does not require specifying "getters: true"', async () => {
      await new UserWithGetter({username: TEST_USERNAME}).save();
      const user = await UserWithGetter.findOne({username: TEST_USERNAME}).lean();
      const userGetter = user as LeanUserGetter;

      expect(userGetter?.username).toBe(TEST_USERNAME.toUpperCase());
    });

    it('Allows to override "getters: true" when using .lean()', async () => {
      await new UserWithGetter({username: TEST_USERNAME}).save();
      const user = await UserWithGetter.findOne({username: TEST_USERNAME}).lean({getters: false});
      const userGetter = user as LeanUserGetter | null;

      expect(userGetter?.username).toBe(TEST_USERNAME);
    });
  });

  describe('Bonus functionality (no version key in lean documents)', () => {
    const User = M.model('User', toMongooseSchema(z.object({username: z.string()}).mongoose()));

    it('Sets "versionKey: false" when using .lean()', async () => {
      await new User({username: TEST_USERNAME}).save();
      const user = await User.findOne({username: TEST_USERNAME}).lean();
      const userDefaults = user as LeanUserDefaults | null;
      expect(userDefaults?.__v).toBe(undefined);
    });

    it('Allows to override "versionKey: false" when using .lean()', async () => {
      await new User({username: TEST_USERNAME}).save();
      const user = await User.findOne({username: TEST_USERNAME}).lean({versionKey: true});
      const userDefaults = user as LeanUserDefaults | null;
      expect(userDefaults?.__v).toBe(0);
    });
  });
});
