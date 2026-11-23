// Jenkinsfile for portfolio — builds, scans, and deploys to STAGING only.
// Production is promoted by a PR in thales-kubernetes copying the tag that
// passed Flagger's blue/green analysis in portfolio-staging (CICD-02); the same analysis
// then runs again in production.
//
// Every branch and PR builds and scans. Only main pushes the image and stages it, and the
// push comes after the scan, so an image that fails Trivy never reaches the registry.

pipeline {
    agent {
        kubernetes {
            yaml """
apiVersion: v1
kind: Pod
metadata:
  labels:
    jenkins: agent
spec:
  serviceAccountName: jenkins-agent
  containers:
  - name: kaniko
    image: gcr.io/kaniko-project/executor:debug
    command:
    - sleep
    args:
    - 99d
  - name: git
    image: alpine/git:2.54.0
    command:
    - sleep
    args:
    - 99d
  - name: trivy
    image: aquasec/trivy:0.74.0
    command:
    - sleep
    args:
    - 99d
  - name: crane
    image: gcr.io/go-containerregistry/crane:debug@sha256:e78770b31258a3846f878036d9c1f63fbe4c871f9f56990bf77fd95c013e3c1b
    command:
    - sleep
    args:
    - 99d
"""
        }
    }

    environment {
        REGISTRY = '10.10.20.31:5000'
        IMAGE_NAME = 'portfolio'
        MANIFEST_REPO = 'git@github.com:jasonharker/thales-kubernetes.git'
        MANIFEST_FILE = 'apps/portfolio-staging/deployment.yaml'
    }

    stages {
        stage('Build Image') {
            steps {
                script {
                    def shortCommit = GIT_COMMIT.take(8)
                    // "Topology as of <date>" (spec §4). Kaniko's context has no .git, so read it here.
                    // A shallow clone would report HEAD's date for the file, so emit nothing (the
                    // site shows "unknown") unless full history is present.
                    def topologyDate = ''
                    container('git') {
                        topologyDate = sh(returnStdout: true, script: '''
                            g() { git -c safe.directory="$PWD" "$@"; }
                            if [ "$(g rev-parse --is-shallow-repository)" = true ]; then g fetch --quiet --unshallow || true; fi
                            if [ "$(g rev-parse --is-shallow-repository)" = false ]; then g log -1 --format=%cs -- src/data/topology.yaml; fi
                        ''').trim()
                    }
                    echo "Topology as of: ${topologyDate ?: 'unknown'}"
                    container('kaniko') {
                        sh """
                            /kaniko/executor \\
                                --context=\$(pwd) \\
                                --dockerfile=Dockerfile \\
                                --destination=${REGISTRY}/${IMAGE_NAME}:${shortCommit} \\
                                --no-push \\
                                --tar-path=image.tar \\
                                --build-arg=TOPOLOGY_DATE=${topologyDate} \\
                                --insecure \\
                                --skip-tls-verify \\
                                --cache=true \\
                                --cache-repo=${REGISTRY}/${IMAGE_NAME}-cache
                        """
                    }
                }
            }
        }

        stage('Vulnerability Scan') {
            steps {
                container('trivy') {
                    // Policy gate: Trivy's misconfiguration checks on the Dockerfile.
                    sh 'trivy config --severity HIGH,CRITICAL --exit-code 1 Dockerfile'
                    sh 'trivy image --input image.tar --format json -o trivy-report.json'
                    archiveArtifacts artifacts: 'trivy-report.json', allowEmptyArchive: true
                    sh 'trivy image --input image.tar --severity CRITICAL --exit-code 1'
                }
            }
        }

        stage('Publish Image') {
            when { branch 'main' }
            steps {
                container('crane') {
                    sh "crane push --insecure image.tar ${REGISTRY}/${IMAGE_NAME}:${GIT_COMMIT.take(8)}"
                }
            }
        }

        stage('Deploy to Staging') {
            when { branch 'main' }
            steps {
                withCredentials([sshUserPrivateKey(credentialsId: 'github-ssh-deploy-key', keyFileVariable: 'SSH_KEY')]) {
                    script {
                        def shortCommit = GIT_COMMIT.take(8)
                        container('git') {
                            sh """
                                git config --global user.email "243025617+jasonharker@users.noreply.github.com"
                                git config --global user.name "Jenkins CI"
                                mkdir -p ~/.ssh
                                cp ${SSH_KEY} ~/.ssh/id_ed25519
                                chmod 600 ~/.ssh/id_ed25519
                                ssh-keyscan github.com >> ~/.ssh/known_hosts

                                git clone ${MANIFEST_REPO} k8s-manifests
                                cd k8s-manifests
                                sed -i 's|image: .* # portfolio-image\$|image: ${REGISTRY}/${IMAGE_NAME}:${shortCommit} # portfolio-image|' ${MANIFEST_FILE}
                                git diff ${MANIFEST_FILE}
                            """
                        }
                        // Policy gate on the staging manifests as they will be applied, before the
                        // commit Flux acts on.
                        container('trivy') {
                            sh "trivy config --severity HIGH,CRITICAL --exit-code 1 k8s-manifests/\$(dirname ${MANIFEST_FILE})"
                        }
                        container('git') {
                            sh """
                                cd k8s-manifests
                                git add ${MANIFEST_FILE}
                                git commit -m "🚀 Stage ${IMAGE_NAME}:${shortCommit} (build #${BUILD_NUMBER})" || echo "No changes to commit"
                                git push origin main
                            """
                        }
                    }
                }
            }
        }
    }

    post {
        success {
            script {
                if (env.BRANCH_NAME == 'main') {
                    echo "Staged ${IMAGE_NAME}:${GIT_COMMIT.take(8)} — watch: kubectl -n portfolio-staging get canary portfolio -w"
                }
            }
        }
    }
}
