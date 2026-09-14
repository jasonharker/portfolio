// Jenkinsfile for portfolio — builds, scans, and deploys to STAGING only.
// Production is promoted by a PR in thales-kubernetes copying the tag that
// passed Flagger's blue/green analysis in portfolio-staging (CICD-02).

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
  serviceAccountName: jenkins
  containers:
  - name: kaniko
    image: gcr.io/kaniko-project/executor:debug
    command:
    - sleep
    args:
    - 99d
  - name: git
    image: alpine/git:latest
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
            when { branch 'main' }
            steps {
                container('kaniko') {
                    script {
                        def shortCommit = GIT_COMMIT.take(8)
                        sh """
                            /kaniko/executor \\
                                --context=\$(pwd) \\
                                --dockerfile=Dockerfile \\
                                --destination=${REGISTRY}/${IMAGE_NAME}:${shortCommit} \\
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
            when { branch 'main' }
            steps {
                container('trivy') {
                    script {
                        def shortCommit = GIT_COMMIT.take(8)
                        sh "trivy image --insecure --format json -o trivy-report.json ${REGISTRY}/${IMAGE_NAME}:${shortCommit}"
                        archiveArtifacts artifacts: 'trivy-report.json', allowEmptyArchive: true
                        sh "trivy image --insecure --severity CRITICAL --exit-code 1 ${REGISTRY}/${IMAGE_NAME}:${shortCommit}"
                    }
                }
            }
        }

        stage('Deploy to Staging') {
            when { branch 'main' }
            steps {
                container('git') {
                    withCredentials([sshUserPrivateKey(credentialsId: 'github-ssh-deploy-key', keyFileVariable: 'SSH_KEY')]) {
                        script {
                            def shortCommit = GIT_COMMIT.take(8)
                            sh """
                                git config --global user.email "jenkins@thales.local"
                                git config --global user.name "Jenkins CI"
                                mkdir -p ~/.ssh
                                cp ${SSH_KEY} ~/.ssh/id_ed25519
                                chmod 600 ~/.ssh/id_ed25519
                                ssh-keyscan github.com >> ~/.ssh/known_hosts

                                git clone ${MANIFEST_REPO} k8s-manifests
                                cd k8s-manifests
                                sed -i 's|image: ${REGISTRY}/${IMAGE_NAME}:.*|image: ${REGISTRY}/${IMAGE_NAME}:${shortCommit}|' ${MANIFEST_FILE}
                                git diff ${MANIFEST_FILE}
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
            echo "Staged ${IMAGE_NAME}:${GIT_COMMIT.take(8)} — watch: kubectl -n portfolio-staging get canary portfolio -w"
        }
    }
}
