import M from 'mongoose';
import {z} from 'zod';
import {toMongooseSchema} from '../src/index.js';

describe('Schema virtuals', () => {
  beforeEach(() => {
    for (const modelName of M.connection.modelNames()) {
      M.deleteModel(modelName);
    }
  });

  interface NameDoc {
    firstName: string;
    lastName: string;
  }

  const SCHEMA_WITH_VIRTUALS = z
    .object({
      firstName: z.string(),
      lastName: z.string(),
    })
    .mongoose({
      schemaOptions: {
        virtuals: {
          fullName: {
            get(this: NameDoc): string {
              return `${this.firstName} ${this.lastName}`;
            },
            set(this: NameDoc, fullName: string) {
              const [fn = '', ln = ''] = fullName.trim().split(' ');
              this.firstName = fn;
              this.lastName = ln;
            },
          },
        },
      },
    });

  it('Registeres the virtuals declared in root schema options', () => {
    const zodSchema = SCHEMA_WITH_VIRTUALS;

    const Model = M.model('test', toMongooseSchema(zodSchema));
    const instance = new Model({firstName: 'A', lastName: 'B'}) as M.Document &
      NameDoc & {fullName: string};

    expect(instance.fullName).toEqual(`A B`);

    instance.fullName = 'C D';

    expect(instance.firstName).toEqual('C');
    expect(instance.lastName).toEqual('D');
  });

  it('Registeres the virtuals declared in sub schema options', () => {
    const zodSchema = z.object({name: SCHEMA_WITH_VIRTUALS}).mongoose();

    const Model = M.model('test', toMongooseSchema(zodSchema));
    const instance = new Model({name: {firstName: 'A', lastName: 'B'}}) as M.Document & {
      name: NameDoc & {fullName: string};
    };

    expect(instance.name.fullName).toEqual(`A B`);

    instance.name.fullName = 'C D';

    expect(instance.name.firstName).toEqual('C');
    expect(instance.name.lastName).toEqual('D');
  });
});
