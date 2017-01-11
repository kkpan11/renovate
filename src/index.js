const semver = require('semver');
const winston = require('winston');

const github = require('./helpers/github');
const npm = require('./helpers/npm');
const packageJson = require('./helpers/packageJson');

const config = initConfig();
const logger = config.logger;
logger.verbose(`config = ${JSON.stringify(config)}`);
validateArguments();
npm.init(config);

// Initialize our promise chain
let p = Promise.resolve();

// Queue up each repo/package combination
config.repositories.forEach((repo) => {
  const repoName = repo.name;
  repo.packageFiles.forEach((packageFile) => {
    p = p.then(() => processRepoPackageFile(repoName, packageFile));
  });
});
// Print something nice once the chain is done
p
  .then(() => {
    // eslint-disable-next-line promise/always-return
    if (config.repositories.length > 1) {
      logger.info('All repos done');
    }
  })
  .catch((error) => {
    logger.error(`Unexpected error: ${error}`);
  });

// This function reads in all configs and merges them
function initConfig() {
  /* eslint-disable global-require */
  const defaultConfig = require('./defaults');
  let customConfig = {};
  try {
    customConfig = require('./config');
  } catch (err) {
    // Do nothing
  }
  /* eslint-enable global-require */
  const cliConfig = {};
  if (process.env.LOG_LEVEL) {
    cliConfig.logLevel = process.env.LOG_LEVEL;
  }
  if (process.env.RENOVATE_TOKEN) {
    cliConfig.token = process.env.RENOVATE_TOKEN;
  }
  // Check if repository name and package file are provided via CLI
  const repoName = process.argv[2];
  const packageFile = process.argv[3] || 'package.json';
  if (repoName) {
    cliConfig.repositories = [
      {
        name: repoName,
        packageFiles: [packageFile],
      },
    ];
  }
  const combinedConfig = Object.assign(defaultConfig, customConfig, cliConfig);
  // First, convert any strings to objects
  combinedConfig.repositories.forEach((repo, index) => {
    if (typeof repo === 'string') {
      combinedConfig.repositories[index] = { name: repo };
    }
  });
  // Add 'package.json' if missing
  combinedConfig.repositories.forEach((repo, index) => {
    if (!repo.packageFiles || !repo.packageFiles.length) {
      combinedConfig.repositories[index].packageFiles = ['package.json'];
    }
  });

  // Add the logger
  combinedConfig.logger = new (winston.Logger)({
    transports: [
      // colorize the output to the console
      new (winston.transports.Console)({ colorize: true }),
    ],
  });

  // Winston log level can be controlled via config or env
  if (combinedConfig.logLevel) {
    combinedConfig.logger.level = combinedConfig.logLevel;
  }
  return combinedConfig;
}

// This function makes sure we have a token and at least one repository
function validateArguments() {
  // token must be defined
  if (typeof config.token === 'undefined') {
    logger.error('Error: A GitHub token must be configured');
    process.exit(1);
  }
  // We also need a repository
  if (!config.repositories || config.repositories.length === 0) {
    logger.error('Error: At least one repository must be configured');
  }
}

// This function manages the queue per-package file
function processRepoPackageFile(repoName, packageFile) {
  return initGitHub(repoName, packageFile)
    .then(getPackageFileContents)
    .then(determineUpgrades)
    .then(processUpgradesSequentially)
    // eslint-disable-next-line promise/always-return
    .then(() => {
      logger.info(`Repo ${repoName} ${packageFile} done`);
    })
    .catch((error) => {
      logger.error(`renovate caught error: ${error}`);
    });
}

function initGitHub(repoName, packageFile) {
  logger.info(`Initializing GitHub repo ${repoName}, ${packageFile}`);
  return github.init(config, repoName, packageFile);
}

function getPackageFileContents() {
  logger.info('Getting package file contents');
  return github.getPackageFileContents();
}

function determineUpgrades(packageFileContents) {
  logger.info('Determining required upgrades');
  return npm.getAllDependencyUpgrades(packageFileContents);
}

function processUpgradesSequentially(upgrades) {
  if (Object.keys(upgrades).length) {
    logger.info('Processing upgrades');
  } else {
    logger.info('No upgrades to process');
  }
  logger.verbose(`All upgrades: ${JSON.stringify(upgrades)}`);
  // We are processing each upgrade sequentially for two major reasons:
  // 1. Reduce chances of GitHub API rate limiting
  // 2. Edge case collision of branch name, e.g. dependency also listed as dev dependency
  return upgrades.reduce(
    (promise, upgrade) => promise.then(() => updateDependency(upgrade)), Promise.resolve());
}

function updateDependency({ upgradeType, depType, depName, currentVersion, newVersion }) {
  const newVersionMajor = semver.major(newVersion);
  const branchName = config.templates.branchName({
    depType,
    depName,
    currentVersion,
    newVersion,
    newVersionMajor,
  });
  let prTitle = '';
  if (upgradeType === 'pin') {
    prTitle = config.templates.prTitlePin({
      depType,
      depName,
      currentVersion,
      newVersion,
      newVersionMajor,
    });
  } else if (upgradeType === 'minor') {
    // Use same title for range or minor
    prTitle = config.templates.prTitleMinor({
      depType,
      depName,
      currentVersion,
      newVersion,
      newVersionMajor,
    });
  } else {
    prTitle = config.templates.prTitleMajor({
      depType,
      depName,
      currentVersion,
      newVersion,
      newVersionMajor,
    });
  }
  const prBody = config.templates.prBody({
    depName,
    currentVersion,
    newVersion,
  });
  const commitMessage = config.templates.commitMessage({
    depName,
    currentVersion,
    newVersion,
  });

  // Check if same PR already existed and skip if so
  // This allows users to close an unwanted upgrade PR and not worry about seeing it raised again
  return github.checkForClosedPr(branchName, prTitle).then((prExisted) => {
    if (prExisted) {
      logger.verbose(`${depName}: Skipping due to existing PR found.`);
      return Promise.resolve();
    }
    return ensureAll();
  });
  function ensureAll() {
    return ensureBranch()
    .then(ensureCommit)
    .then(ensurePr)
    .catch((error) => {
      logger.error(`Error updating dependency ${depName}:  ${error}`);
      // Don't throw here - we don't want to stop the other renovations
    });
  }
  function ensureBranch() {
    // Save an API call by attempting to create branch without checking for existence first
    return github.createBranch(branchName).catch((error) => {
      // Check in case it's because the branch already existed
      if (error.response.body.message !== 'Reference already exists') {
        // In this case it means we really do have a problem and can't continue
        logger.error(`Error creating branch: ${branchName}`);
        logger.error(`Response body: ${error.response.body}`);
        throw error;
      }
      // Otherwise we swallow this error and continue
    });
  }
  function ensureCommit() {
    // Retrieve the package.json from this renovate branch
    return github.getPackageFile(branchName).then((res) => {
      const currentSHA = res.body.sha;
      const currentFileContent = new Buffer(res.body.content, 'base64').toString();
      const currentJson = JSON.parse(currentFileContent);
      if (currentJson[depType][depName] === newVersion) {
        logger.verbose(`${depName}: branch ${branchName} is already up-to-date`);
        return Promise.resolve();
      }
      // Branch must need updating
      logger.verbose(`${depName}: Updating to ${newVersion} in branch ${branchName}`);
      const newPackageContents = packageJson.setNewValue(
        currentFileContent,
        depType,
        depName,
        newVersion);
      return github.writePackageFile(
        branchName,
        currentSHA,
        newPackageContents,
        commitMessage);
    });
  }

  // Ensures that PR exists with matching title/body
  function ensurePr() {
    // Create PR based on current state
    function createPr() {
      return github.createPr(branchName, prTitle, prBody).then((newPr) => {
        logger.info(`${depName}: Created PR #${newPr.number}`);
        return Promise.resolve();
      });
    }
    // Update PR based on current state
    function updatePr(existingPr) {
      return github.updatePr(existingPr.number, prTitle, prBody).then(() => {
        logger.info(`${depName}: Updated PR #${existingPr.number}`);
        return Promise.resolve();
      });
    }
    // Process a returned PR
    function processExistingPr(existingPr) {
      if (!existingPr) {
        // We need to create a new PR
        return createPr();
      }
      // Check if existing PR needs updating
      if (existingPr.title === prTitle || existingPr.body === prBody) {
        logger.verbose(`${depName}: PR #${existingPr.number} already up-to-date`);
        return Promise.resolve();
      }
      // PR must need updating
      return updatePr(existingPr);
    }

    return github.getPr(branchName)
    .then(processExistingPr)
    .catch((error) => {
      logger.error(`${depName} failed to ensure PR: ${error}`);
    });
  }
}
