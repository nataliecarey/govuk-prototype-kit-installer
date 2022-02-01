const stat = require('fs').stat
const readFile = require('fs').readFile
const writeFile = require('fs').writeFile
const readdir = require('fs').promises.readdir
const mkdir = require('fs').promises.mkdir
const join = require('path').join
const dirname = require('path').dirname
const sep = require('path').sep
const fileURLToPath = require('url').fileURLToPath
const get = require('https').get
const marked = require('marked')
const open = require('open')
const sass = require('sass')
const nunjucks = require('nunjucks')
const express = require('express')
const bodyParser = require('body-parser')

const userHome = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME']
const configFile = process.env.GOVUK_PROTOTYPE_KIT_INIT_CONFIG_FILE || join(userHome, '.govuk-prototype-kit-init.config.json')
const configFileParent = join('configFile', '..')
const app = express()
const port = process.env.PORT || 0
const rootDir = join(__dirname, '..')//dirname(fileURLToPath(import.meta.url));

app.use(bodyParser.urlencoded({extended: false}))

let configFilePromise

nunjucks.configure(['views', join(rootDir, 'node_modules', 'govuk-frontend')], {
  autoescape: true,
  express: app,
  watch: true
})

const forceArray = (thing) => thing === undefined || thing === null ? [] : Array.isArray(thing) ? thing : [thing]
const sassPromise = new Promise((res, rej) => {
  sass.render({
    file: join('node_modules', 'govuk-frontend', 'govuk', 'all.scss')
  }, (err, result) => {
    if (err) {
      rej(err)
    } else {
      res(result.css.toString())
    }
  })
})

configFilePromise = new Promise((res, rej) => {
  stat(configFileParent, (err, stats) => {
    if (err) {
      console.error(`Couldn't find director ${configFileParent}`)
      rej(err)
      return
    }
    if (!stats.isDirectory()) {
      console.error(`'Couldn't find your home directory - it is not a directory ${userHome}`)
      rej(new Error('Home directory is not a directory.'))
      return
    }
    stat(configFile, (err, stats) => {
      if (err && err.code === 'ENOENT') {
        writeFile(configFile, '{}\n', 'utf8', (err) => {
          if (err) {
            rej(err)
            return
          }
          res({})
        })
      } else if (err) {
        console.error(`Couldn't find director ${configFileParent}`)
        rej(err)
        return
      } else {
        readFile(configFile, 'utf8', (err, contents) => {
          if (err) {
            rej(err)
            return
          }
          res(JSON.parse(contents))
        })
      }
    })
  })
})

app.get('/', (req, res) => {
  configFilePromise.then(config => {
    console.log(JSON.stringify(config, null, 2))
    res.render('index.njk', {config})
  }).catch((err) => {
    console.log(err)
    res.status(500).send(`Error`)
  })
})
app.post('/', redirectEndpoint('new-or-existing', {
  'new': '/new-prototype-kit',
  existing: '/existing-prototype-kit'
}))


app.get('/new-prototype-kit', (req, res) => {
  getReleases().then(result => {
    res.render('newKit.njk', {latestRelease: result.releases[0]})
  }).catch((err) => {
    console.log(err)
    res.status(500).send(`Error`)
  })
})
app.post('/new-prototype-kit', redirectEndpoint('latest-or-specific', {
  latest: '/new-prototype-kit/latest',
  specific: '/new-prototype-kit/choose-release/page-1'
}))
app.get('/new-prototype-kit/latest', (req, res) => {
  getReleases().then(result => {
    res.redirect(`/new-prototype-kit/${encodeURIComponent(result.releases[0].tag_name)}`)
  }).catch((err) => {
    console.log(err)
    res.status(500).send(`Error`)
  })
})

app.get('/new-prototype-kit/choose-release/:page', (req, res) => {
  const pageNumber = parseInt(req.params.page.split('-')[1], 10);
  getReleases(pageNumber).then(result => {
    const preparedReleaseItems = result.releases.map(release => ({
      value: release.tag_name,
      html: `${release.tag_name} released on ${release.created_at.split('T')[0]}. <a href="${release.html_url}" class="govuk-link" rel="noreferrer noopener" target="_blank">Release notes (opens in new tab)</a>`
    }))
    if (result.previousPageURL || result.nextPageURL) {
      preparedReleaseItems.push({divider: 'or'})
      if (result.previousPageURL) {
        preparedReleaseItems.push({
          value: 'previous',
          text: 'Find a newer release'
        })
      }
      if (result.nextPageURL) {
        preparedReleaseItems.push({
          value: 'next',
          text: 'Find an older release'
        })
      }
    }
    res.render('chooseRelease.njk', {
      preparedReleaseItems
    })
  })
})
app.post('/new-prototype-kit/choose-release/:page', (req, res) => {
  const pageNumber = parseInt(req.params.page.split('-')[1], 10);
  const chosenRelease = req.body.release;
  if (chosenRelease.startsWith('v')) {
    res.redirect(`/new-prototype-kit/${encodeURIComponent(chosenRelease)}`)
  } else if (chosenRelease === 'next') {
    res.redirect(`/new-prototype-kit/choose-release/page-${pageNumber + 1}`)
  } else if (chosenRelease === 'previous') {
    res.redirect(`/new-prototype-kit/choose-release/page-${pageNumber - 1}`)
  } else {
    res.status(400).send(`Unknown option: ${chosenRelease}`)
  }
})

app.get('/new-prototype-kit/:release', (req, res) => {
  getFromGitubApi(`/repos/alphagov/govuk-prototype-kit/releases/tags/${encodeURIComponent(req.params.release)}`)
    .then(result => {
      console.log(result)
      res.render('confirmRelease.njk', {
        version: result.response.tag_name,
        releaseNotes: marked.parse(result.response.body)
      })
    })
})
app.post('/new-prototype-kit/:release', (req, res) => {
  if (req.body.confirm === 'yes') {
    res.redirect(`/new-prototype-kit/${encodeURIComponent(req.params.release)}/serviceName`)
  } else {
    res.redirect('/new-prototype-kit')
  }
})

app.get('/new-prototype-kit/:release/serviceName', (req, res) => {
  res.render('serviceName.njk', {
    isMissingError: req.query.error === 'enter-a-service-name'
  })
})
app.post('/new-prototype-kit/:release/serviceName', (req, res) => {
  const serviceName = req.body['service-name'];
  if (serviceName) {
    res.redirect(`/new-prototype-kit/${encodeURIComponent(req.params.release)}/${encodeURIComponent(serviceName)}/location`)
  } else {
    res.redirect(`/new-prototype-kit/${encodeURIComponent(req.params.release)}/serviceName?error=enter-a-service-name`)
  }
})

app.get('/new-prototype-kit/:release/:serviceName/location', (req, res) => {
  const cwd = req.query.dir || userHome;
  const parentDirectoryParts = cwd.split(sep)
  parentDirectoryParts.pop()
  const parentDirectory = '/' + join.apply(null, parentDirectoryParts)
  getDirectories(cwd).then(dirs => {
    const preparedDirItems = dirs.map(dir => ({
      value: join(cwd, dir),
      html: '<code>' + dir + '</code>'
    }))
    const numberOfDirs = preparedDirItems.length
    if (numberOfDirs === 0) {
      preparedDirItems.unshift({
        value: 'use-folder-govuk-prototype-kit-installer:' + cwd,
        text: 'Use this directory'
      })
    }
    if (preparedDirItems.length > 0) {
      preparedDirItems.push({divider: 'or'})
    }
    preparedDirItems.push({
      value: parentDirectory,
      text: 'Go to the parent directory'
    })
    preparedDirItems.push({
      value: 'create-folder-govuk-prototype-kit-installer',
      text: 'Create a new directory here',
      id: 'create-dir',
      conditional: {
        html: `<div class="govuk-form-group">
          <label class="govuk-label" for="create-dir">
            What name would you like this new directory to have?
          </label>
          <input class="govuk-input govuk-!-width-one-third" id="create-dir" name="new-dir-name"></div>`
      }
    })

    res.render('filePicker.njk', {cwd: cwd, preparedDirItems, isNonEmptyError: req.query.error === 'non-empty'})
  })
})
app.post('/new-prototype-kit/:release/:serviceName/location', (req, res) => {
  function redirectTo(path) {
    res.redirect(`/new-prototype-kit/${encodeURIComponent(req.params.release)}/${encodeURIComponent(req.params.serviceName)}/location?dir=${encodeURIComponent(path)}`)
  }

  if (!req.body.dir) {
    res.status(400).send('No directory specified.')
  } else if (req.body.dir.startsWith('use-folder-govuk-prototype-kit-installer:')) {
    const dirToUse = req.body.dir.split('use-folder-govuk-prototype-kit-installer:')[1]
    directoryIsEmpty(dirToUse).then(isEmpty => {
      if (isEmpty) {
        res.redirect(`/new-prototype-kit/${encodeURIComponent(req.params.release)}/${encodeURIComponent(req.params.serviceName)}/${encodeURIComponent(dirToUse)}/extensions`)
      } else {
        res.redirect(`${req.url.split('?')[0]}?dir=${encodeURIComponent(dirToUse)}&error=non-empty`)
      }
    })
  } else if (req.body.dir === 'create-folder-govuk-prototype-kit-installer') {
    const directoryFullPath = join(req.body.cwd, req.body['new-dir-name'])
    mkdir(directoryFullPath).then(() => {
      redirectTo(req.body.cwd)
    })
  } else {
    redirectTo(req.body.dir);
  }
})

app.get('/new-prototype-kit/:release/:serviceName/:dir/extensions', (req, res) => {
  res.render('extensions.njk', {dir: req.params.dir});
})
app.post('/new-prototype-kit/:release/:serviceName/:dir/extensions', (req, res) => {
  const extensions = forceArray(req.body.extensions);
  res.redirect(`/new-prototype-kit/${encodeURIComponent(req.params.release)}/${encodeURIComponent(req.params.serviceName)}/${encodeURIComponent(req.params.dir)}/${encodeURIComponent(JSON.stringify(extensions))}/check-your-answers`)
})

app.get('/new-prototype-kit/:release/:serviceName/:dir/:extensions/check-your-answers', (req, res) => {
  const format = (key, paramsKey, link) => ({
      key: {
        text: key
      },
      value: {
        text: req.params[paramsKey]
      },
      actions: {
        items: [
          {
            href: link,
            text: "Change",
            visuallyHiddenText: "name"
          }
        ]
      }
    })
  const preparedRows = []
  preparedRows.push(format('Release', 'release', '/new-prototype-kit'))
  preparedRows.push(format('Service Name', 'serviceName', `/new-prototype-kit/${encodeURIComponent(req.params.release)}/serviceName`))
  preparedRows.push(format('Directory', 'dir', `/new-prototype-kit/${encodeURIComponent(req.params.release)}/${encodeURIComponent(req.params.serviceName)}/location?dir=${encodeURIComponent(req.params.dir)}`))
  const extensions = format('Extensions', 'extensions', `/new-prototype-kit/${encodeURIComponent(req.params.release)}/${encodeURIComponent(req.params.serviceName)}/${encodeURIComponent(req.params.dir)}/extensions`)
  delete extensions.value.text
  const extensionsList = JSON.parse(req.params.extensions).map(x => `<li>${x}</li>`).join('')
  extensions.value.html = extensionsList.length === 0 ? 'No extensions' : `<ul class="govuk-list">${extensionsList}</ul>`
  preparedRows.push(extensions)
  res.render('checkYourAnswers.njk', {preparedRows});
})
app.post('/new-prototype-kit/:release/:serviceName/:dir/:extensions/check-your-answers', (req, res) => {
  const extensions = forceArray(req.body.extensions)
  const release = req.body.release
  const serviceName = req.body.serviceName
  const dir = req.body.dir


})

app.get('/assets/all.css', (req, res) => {
  sassPromise.then((cssContents) => {
    res.set('Content-Type', 'text/css')
    res.send(cssContents)
  })
})
app.use('/assets/all.js', express.static('node_modules/govuk-frontend/govuk/all.js'))
app.use('/assets', express.static('node_modules/govuk-frontend/govuk/assets'))

Promise.all([configFilePromise, sassPromise]).then((results) => {
  const config = results[0]
  const server = app.listen(port, () => {
    const port = server.address().port
    const url = `http://localhost:${port}/`
    console.log(`listening on ${url}`)
    console.log(JSON.stringify(config, null, 2))
    open(url)
  })
})

const getReleases = (page) => getFromGitubApi(`/repos/alphagov/govuk-prototype-kit/releases?per_page=10&page=${parseInt(page, 10)}`).then(res => {
  return {
    releases: res.response,
    nextPageURL: res.links['next'],
    previousPageURL: res.links['prev']
  }
})

const getFromGitubApi = (url) => new Promise((resolve, rej) => {
  const parts = []
  get({
    hostname: 'api.github.com',
    path: url,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36'
    }
  }, (res) => {
    const statusCode = res.statusCode
    res.on('data', (chunk) => {
      parts.push(chunk)
    })
    res.on('end', () => {
      const response = JSON.parse(parts.join(''))

      if (statusCode === 403 && response.message && response.message.startsWith('API rate limit exceeded')) {
        rej(new Error(`You've clearly been appreciating the service, you've hit the usage limit on Github, here's the message Github provided with the error:\n<br/><br/>\n\n${response.message}`))
        return;
      } else if (statusCode !== 200) {
        rej(new Error(`Non 200 status code provided ${statusCode}, ${JSON.stringify(response, null, 2)}`))
        return;
      } else {
        const links = {}
        if (res.headers.link) {
          res.headers.link.split(', ').forEach(link => {
            const matches = link.match(/^<([^>]+)>; rel="([^"]+)"/)
            if (matches) {
              links[matches[2]] = matches[1]
            } else {
              console.warn(`no matches found for link [${link}]`)
            }
          })
        }
        resolve({
          response,
          statusCode,
          links
        })
      }
    });
  }).on('error', (err) => {
    console.log(err)
    rej(err)
  })
})

function redirectEndpoint(key, redirects) {
  return (req, res) => {
    const value = req.body[key];
    if (redirects.hasOwnProperty(value)) {
      res.redirect(redirects[value])
    } else {
      res.status(400).send(`Unknown option: ${value}`)
    }
  };
}

// Stolen from https://stackoverflow.com/questions/18112204/get-all-directories-within-directory-nodejs
const getDirectories = async source =>
  (await readdir(source, {withFileTypes: true}))
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .filter(name => !name.startsWith('.'))
    .sort()

const directoryIsEmpty = async source =>
  (await readdir(source, {withFileTypes: true})).length === 0
