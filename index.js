const http = require ( 'http' );
const rp = require ( 'request-promise-native' );
const createHandler = require ( 'github-webhook-handler' );
const url = require( 'url' );
const { logger } = require( '@automattic/vip-go' );

const calypsoProject = process.env.CALYPSO_PROJECT || 'Automattic/wp-calypso';
const wpDesktopProject = process.env.DESKTOP_PROJECT || 'Automattic/wp-desktop';
const flowPatrolOnly = process.env.FLOW_PATROL_ONLY || 'false';

const flowPatrolUsernames = [ 'alisterscott', 'brbrr', 'bsessions85', 'hoverduck', 'rachelmcr', 'designsimply', 'astralbodies' ];
const triggerLabel = process.env.TRIGGER_LABEL || '[Status] Needs Review';

const gitHubStatusURL = `https://api.github.com/repos/${ calypsoProject }/statuses/`;
const gitHubDesktopBranchURL = `https://api.github.com/repos/${ wpDesktopProject }/branches/`;
const gitHubDesktopRefsURL = `https://api.github.com/repos/${ wpDesktopProject }/git/refs`;
const gitHubDesktopHeadsURL = `${ gitHubDesktopRefsURL }/heads/`;

const gitHubWebHookPath = '/ghwebhook';
const circleCIWebHookPath = '/circleciwebhook';
const healthCheckPath = '/cache-healthcheck';

const prContext = 'ci/wp-desktop';

const log = logger( 'wp-desktop-gh-bridge:webhook' );
const handler = createHandler( { path: gitHubWebHookPath, secret: process.env.BRIDGE_SECRET } );
const request = rp.defaults( {
    simple:false,
    resolveWithFullResponse: true
} );

http.createServer( function (req, res) {
    const fullUrl = req.url;
    const path = fullUrl.split( '?' )[0];
    if ( path === gitHubWebHookPath ) {
        handler(req, res, function (err) {
            res.statusCode = 404;
            res.end('invalid location');
        });
    } else if ( path === healthCheckPath ) {
        res.statusCode = 200;
        res.end( 'OK' );
    } else if ( path === circleCIWebHookPath ) {
        log.debug( "Called from CircleCI" );
        let body = [];
        req.on( 'data', function( chunk ) {
            body.push( chunk );
        } ).on( 'end', function() {
            body = Buffer.concat( body ).toString();
            try {
                let payload = JSON.parse( body ).payload;
                if ( payload && payload.build_parameters && payload.build_parameters.sha && payload.build_parameters.calypsoProject === calypsoProject ) {
                    let status, desc;
                    if ( payload.outcome === 'success' ) {
                        status = 'success';
                        desc = 'Your PR passed the wp-desktop tests on CircleCI!';

                        let branch = payload.branch;
                        if( branch.indexOf( 'tests/' ) >= 0 ) {

                            // DELETE branch after successful test runs
                            request.delete( {
                                headers: {
                                    Authorization: 'token ' + process.env.GITHUB_SECRET,
                                    'User-Agent': 'wp-desktop-gh-bridge'
                                },
                                url: gitHubDesktopHeadsURL + branch
                            } )
                            .then( function( response ) {
                                if ( response.statusCode !== 204 ) {
                                    log.error( 'ERROR: Branch delete failed with error: ' + response.body );
                                } else {
                                    log.info( 'Branch ' + branch + ' deleted' );
                                }

                            } )
                            .catch( function( error ) {
                                log.error( 'ERROR: Branch delete failed with error: ' + error )
                            } )
                        }
                    } else if ( payload.outcome === 'failed' ) {
                        status = 'failure';
                        desc = `wp-desktop test status: ${ payload.status }`;
                    } else {
                        status = 'error';
                        desc = `wp-desktop test status: ${ payload.status }`;
                    }
                    // POST to GitHub to provide status
                    let gitHubStatus = {
                        state: status,
                        description: desc,
                        target_url: payload.build_url,
                        context: prContext
                    };
                    request.post( {
                        headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                        url: gitHubStatusURL + payload.build_parameters.sha,
                        body: JSON.stringify( gitHubStatus )
                    } )
                    .then( function( response ) {
                        if ( response.statusCode !== 201 ) {
                            log.error( 'ERROR: ' + response.body );
                        } else {
                            log.debug( 'GitHub status updated' );
                        }
                    } )
                    .catch( function( error ) {
                        log.error( 'ERROR: ' + error )
                    } )
                }
            } catch ( e ) {
                log.info( 'Non-CircleCI packet received' );
            }
            res.statusCode = 200;
            res.end( 'ok' );
        } );
    } else {
        log.error( 'unknown location %s', fullUrl );
        res.statusCode = 404;
        res.end( 'no such location' );
    }
} ).listen( process.env.PORT || 7777 );

handler.on( 'error', function ( err ) {
    log.error( 'Error: %s', err.message );
} );

handler.on( 'pull_request', function ( event ) {
    const pullRequestNum = event.payload.pull_request.number;
    const pullRequestStatus = event.payload.pull_request.state;
    const loggedInUsername = event.payload.sender.login;
    const pullRequestHeadLabel = event.payload.pull_request.head.label;
    const repositoryName = event.payload.repository.full_name;
    const labelsArray = event.payload.pull_request.labels;
    let containsLabel;


    // Check if we should only run for certain users
    if ( flowPatrolOnly === 'true' && flowPatrolUsernames.indexOf( loggedInUsername ) === -1 ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as we're only running for certain users and '${ loggedInUsername }' is not in '${ flowPatrolUsernames }'` );
        return true;
    }

    // Make sure the PR is in the correct repository
    if ( repositoryName !== calypsoProject ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as the repository '${ repositoryName }' is not '${ calypsoProject }'` );
        return true;
    }

    // Make sure the PR is still open
    if ( pullRequestStatus !== 'open' ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as the status '${ pullRequestStatus }' is not 'open'` );
        return true;
    }

    // Ignore OSS requests - check for location of head to indicate forks
    if ( event.payload.pull_request.head.label.indexOf( 'Automattic:' ) !== 0 ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as this is from a fork: '${ pullRequestHeadLabel }'` );
        return true;
    }

    if ( event.payload.action === 'synchronize' ) {
        let filteredLabel = labelsArray.filter( label => label["name"] === triggerLabel );
        containsLabel = filteredLabel.length > 0;
    }

    if ( ( event.payload.action === 'labeled' && event.payload.label.name === triggerLabel ) || containsLabel ) {
        const wpCalypsoBranchName = event.payload.pull_request.head.ref;
        const desktopBranchName = 'tests/' + wpCalypsoBranchName;
        let wpDesktopBranchName;
        log.info( 'Executing wp-desktop tests for wp-calypso branch: \'' + wpCalypsoBranchName + '\'' );

        // Check if there's a matching branch in the wp-desktop repository
        request.get( {
            headers: {Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-desktop-gh-bridge'},
            url: gitHubDesktopBranchURL + desktopBranchName
        } )
        .then ( function( response ) {
            if ( response.statusCode === 200 ) {
                wpDesktopBranchName = desktopBranchName;
                // Get sha for develop branch
                return request.get( {
                    headers: {
                        Authorization: 'token ' + process.env.GITHUB_SECRET,
                        'User-Agent': 'wp-desktop-gh-bridge'
                    },
                    url: gitHubDesktopHeadsURL + 'develop'
                } )
                .then( function( response ) {
                     // Update branch if we can
                    const branch_parameters = {
                        sha: JSON.parse( response.body ).object.sha
                    };
                    return request.patch( {
                        headers: {
                            Authorization: 'token ' + process.env.GITHUB_SECRET,
                            'User-Agent': 'wp-desktop-gh-bridge'
                        },
                        url: gitHubDesktopHeadsURL + wpDesktopBranchName,
                        body: JSON.stringify( branch_parameters )
                    } )
                    .then( function( response ) {
                        if ( response.statusCode !== 200 ) {
                            log.error( 'ERROR: Unable to update existing branch. Failed with error:' + response.body );
                        }
                    } )
                } );
            } else {
                // Get sha for develop branch
                return request.get( {
                    headers: {
                        Authorization: 'token ' + process.env.GITHUB_SECRET,
                        'User-Agent': 'wp-desktop-gh-bridge'
                    },
                    url: gitHubDesktopHeadsURL + 'develop'
                } )
                .then( function( response ) {
                    // Create branch for tests to run from
                    if ( response.statusCode === 200 ) {
                        const branch_parameters = {
                            ref: 'refs/heads/' + desktopBranchName,
                            sha: JSON.parse( response.body ).object.sha
                        };
                        return request.post( {
                            headers: {
                                Authorization: 'token ' + process.env.GITHUB_SECRET,
                                'User-Agent': 'wp-desktop-gh-bridge'
                            },
                            url: gitHubDesktopRefsURL,
                            body: JSON.stringify( branch_parameters )
                        } )
                        .then( function( response ) {
                            if ( response.statusCode === 201 ) {
                                wpDesktopBranchName = desktopBranchName;
                            } else {
                                log.error( 'ERROR: Unable to create new branch. Failed with error:' + response.body );
                            }
                        } )
                    } else {
                        log.error( 'ERROR: Unable to get details for "develop" branch. Failed with error:' + response.body );
                        wpDesktopBranchName = 'develop';
                    }
                } )
            }
        } )
        .then ( function () {

            const triggerBuildURL = `https://circleci.com/api/v1.1/project/github/${ wpDesktopProject }/tree/${ wpDesktopBranchName }?circle-token=${ process.env.CIRCLECI_SECRET}`;

            const sha = event.payload.pull_request.head.sha;

            const buildParameters = {
                build_parameters: {
                    BRANCHNAME: wpDesktopBranchName,
                    sha: sha,
                    CALYPSO_HASH: sha,
                    pullRequestNum: pullRequestNum,
                    calypsoProject: calypsoProject
                }
            };
            // POST to CircleCI to initiate the build
            return request.post( {
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                url: triggerBuildURL,
                body: JSON.stringify( buildParameters )
            } )
            .then( function( response ) {
                if ( response.statusCode === 201 ) {
                    log.debug( 'Tests have been kicked off - updating PR status now' );
                    // Post status to Github
                    const gitHubStatus = {
                        state: 'pending',
                        target_url: JSON.parse( response.body ).build_url,
                        context: prContext,
                        description: 'The wp-desktop tests are running against your PR'
                    };
                    return request.post( {
                        headers: {
                            Authorization: 'token ' + process.env.GITHUB_SECRET,
                            'User-Agent': 'wp-desktop-gh-bridge'
                        },
                        url: gitHubStatusURL + sha,
                        body: JSON.stringify( gitHubStatus )
                    } )
                    .then( function( response ) {
                        if ( response.statusCode !== 201 ) {
                            log.error( 'ERROR: ' + response.body );
                        }
                        log.debug( 'GitHub status updated' );
                    } );
                }
                else {
                    // Something went wrong - TODO: post message to the Pull Request about
                    log.error( 'Something went wrong with executing wp-desktop tests' );
                    log.error( 'ERROR:: %s RESPONSE:: %s', error, JSON.stringify( response ) );
                }
            } );
        } )
        .catch( function ( err ) {
            log.error( err );
        } );
    }
});
