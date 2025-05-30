import { matchRegexOrGlobList } from '../../../util/string-match';
import { defaultConfig } from '.';

describe('modules/manager/circleci/index', () => {
  describe('file names match managerFilePatterns', () => {
    it.each`
      path                           | expected
      ${'.circleci/config.yml'}      | ${true}
      ${'.circleci/config.yaml'}     | ${true}
      ${'.circleci/foo.yaml'}        | ${true}
      ${'.circleci/foo.yml'}         | ${true}
      ${'.circleci/foo/config.yaml'} | ${true}
      ${'.circleci/foo/bar.yml'}     | ${true}
      ${'foo/.circleci/bar.yaml'}    | ${true}
      ${'foo.yml'}                   | ${false}
      ${'circleci/foo.yml'}          | ${false}
      ${'circleci/foo.yml'}          | ${false}
      ${'.circleci_foo/bar.yml'}     | ${false}
      ${'.circleci/foo.toml'}        | ${false}
    `('matchRegexOrGlobList("$path") === $expected', ({ path, expected }) => {
      expect(
        matchRegexOrGlobList(path, defaultConfig.managerFilePatterns),
      ).toBe(expected);
    });
  });
});
